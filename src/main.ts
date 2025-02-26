import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

interface Config {
  GITHUB_TOKEN: string;
  OPENAI_API_KEY: string;
  OPENAI_API_MODEL: string;
  CUSTOM_PROMPT: string;
  EXCLUDE_PATTERNS: string[];
  FALLBACK_TO_GENERAL_COMMENT: boolean;
}

const config: Config = {
  GITHUB_TOKEN: core.getInput("GITHUB_TOKEN"),
  OPENAI_API_KEY: core.getInput("OPENAI_API_KEY"),
  OPENAI_API_MODEL: core.getInput("OPENAI_API_MODEL") || "o3-mini-2025-01-31",
  CUSTOM_PROMPT: core.getInput("CUSTOM_PROMPT"),
  EXCLUDE_PATTERNS: core.getInput("EXCLUDE_PATTERNS").split(",").map(s => s.trim()),
  FALLBACK_TO_GENERAL_COMMENT: core.getBooleanInput("FALLBACK_TO_GENERAL_COMMENT") || true,
};

const octokit = new Octokit({ auth: config.GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: config.OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

interface AIResponse {
  lineNumber: string;
  reviewComment: string;
}

interface Comment {
  body: string;
  path: string;
  line: number;
}

interface ModelPricing {
  uncachedInput: number; // Price per million tokens for uncached input
  cachedInput: number;   // Price per million tokens for cached input
  output: number;        // Price per million tokens for output tokens
}

const pricingMap: Record<string, ModelPricing> = {
  "o3-mini-2025-01-31": {
    uncachedInput: 1.10,
    cachedInput: 0.55,
    output: 4.40,
  },
  "gpt-4o-mini-2024-07-18": {
    uncachedInput: 0.15,
    cachedInput: 0.075,
    output: 0.60,
  },
};

let accumulatedTokenUsage: {
  uncachedTokens: number;
  cachedTokens: number;
  completionTokens: number;
} = {
  uncachedTokens: 0,
  cachedTokens: 0,
  completionTokens: 0,
};

// Add input validation for API keys
if (!config.GITHUB_TOKEN || !config.OPENAI_API_KEY) {
  core.setFailed("Missing required authentication tokens");
}

async function getPRDetails(): Promise<PRDetails> {
  try {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath) {
      throw new Error("GITHUB_EVENT_PATH is not set");
    }
    const eventData = JSON.parse(readFileSync(eventPath, "utf8"));
    if (!eventData.repository || !eventData.number) {
      throw new Error("Invalid event data structure");
    }
    const { repository, number } = eventData;

    const prResponse = await octokit.pulls.get({
      owner: repository.owner.login,
      repo: repository.name,
      pull_number: number,
    });
    return {
      owner: repository.owner.login,
      repo: repository.name,
      pull_number: number,
      title: prResponse.data.title ?? "",
      description: prResponse.data.body ?? "",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(`Failed to get PR details: ${message}`);
    throw error; // Re-throw the error to be caught by the main function.
  }
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });

  // @ts-expect-error - response.data is a string
  return response.data;
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  // Use an explicit type for better clarity
  let files: any[] = [];

  try {
    const response = await octokit.pulls.listFiles({
      owner: prDetails.owner,
      repo: prDetails.repo,
      pull_number: prDetails.pull_number,
    });
    files = response.data;
    
    console.log(`Pull Request Number: ${prDetails.pull_number}`);
    console.log("Files in Pull Request:", { files: files.map((file) => file.filename) });
  } catch (error) {
    console.error("Error fetching changed files:", error);
    throw error;
  }
  
  console.log("========= Reviewing ====================");
  for (const file of parsedDiff) {
    // Use files.some to check if file.to exists in the changed files by comparing filenames
    // Skip this file if it was deleted (indicated by "/dev/null") or if it's not in the list of changed files
    if (file.to === "/dev/null" || !files.some((f) => f.filename === file.to)) {
      console.log("Ignored File:", file.to);
      continue;
    }

    console.log("Reviewing File:", file.to);

    const chunkPromises = file.chunks.map(async (chunk) => {
      try {
        const prompt = createPrompt(file, chunk, prDetails);
        const aiResponse = await getAIResponse(prompt);
        if (aiResponse) {
          return createComments(file, aiResponse);
        }
      } catch (error) {
        console.error(
          `Error processing chunk in file ${file.to}: ${error instanceof Error ? error.stack : error}`
        );
      }
      return [];
    });

    const chunkCommentsArrays = await Promise.all(chunkPromises);
    for (const chunkComments of chunkCommentsArrays) {
      comments.push(...chunkComments);
    }
  }
  return comments;
}

/**
 * Creates a prompt for AI code review
 * @param file - The file being reviewed
 * @param chunk - The diff chunk to review
 * @param prDetails - Pull request details
 * @returns Formatted prompt string
 */
function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  return `Act as an experienced full stack engineer focused solely on identifying actionable errors, bugs, design issues, and writing quality in code reviews. Your task is to review pull requests. 
  Instructions:
	-	Response Format: Provide the response in JSON using the following format: {"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
	-	Markdown: Write review comments in GitHub Markdown format.
	-	No Explanations: Do not output any reasoning or internal thought process.
	-	Never suggest adding comments or documentation to the code.
	-	Do not include positive comments or compliments.
	-	Actionable Feedback Only: Generate review comments only for specific errors, bugs, or design issues. If no issues are detected, “reviews” should be an empty array. 
  - Avoid generic reminders (e.g., verifying branch names or variable definitions) unless they break explicit project rules. Ignore syntax and compilation errors and ignore any issues that can be caught during build time.
	-	Context Use: Use the provided description only for overall context and review only code and newly added/edited comments.
	-	Usage Checks: Do not suggest checking if a variable or an import is used.
	-	Writing Quality: Fix typos, grammar, and spelling. Ensure one idea per sentence. Simplify complex sentences. One comment can address several issues.

${config.CUSTOM_PROMPT}

Review the following code diff in the file "${
    file.to
  }" and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
  // @ts-expect-error - ln and ln2 exists where needed
  .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join("\n")}
\`\`\`
`;
}

async function getAIResponse(prompt: string): Promise<AIResponse[] | null> {
  const queryConfig = {
    model: config.OPENAI_API_MODEL,
    //temperature: 0.2,
    max_completion_tokens: 1000,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    const response = await openai.chat.completions.create({
      ...queryConfig,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    const usage = response.usage;
    const promptTokens = usage?.prompt_tokens || 0;
    const completionTokens = usage?.completion_tokens || 0;
    const cachedTokens = usage?.prompt_tokens_details?.cached_tokens || 0;
    const uncachedTokens = promptTokens - cachedTokens;

    accumulatedTokenUsage.uncachedTokens += uncachedTokens;
    accumulatedTokenUsage.cachedTokens += cachedTokens;
    accumulatedTokenUsage.completionTokens += completionTokens;

    const res = response.choices[0].message?.content?.trim() || "{}";
    let parsedReviews;
    try {
      parsedReviews = JSON.parse(res).reviews;
    } catch (parseError) {
      console.error("Error parsing AI response JSON:", parseError);
    }
    return parsedReviews;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error fetching AI response:", message);
    return null;
  }
}

function createComments(
  file: File,
  aiResponses: AIResponse[]
): Comment[] {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }
    return {
      body: aiResponse.reviewComment,
      path: file.to,
      line: Number(aiResponse.lineNumber),
    };
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Comment[]
): Promise<void> {
  for (const comment of comments) {
    try {
      await octokit.pulls.createReview({
        owner,
        repo,
        pull_number,
        event: 'COMMENT',
        comments: [
          {
            path: comment.path,
            side: 'RIGHT',
            line: comment.line,
            body: comment.body,
          },
        ],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Error creating review comment on line ${comment.line} of ${comment.path}:`,
        message
      );

      if (config.FALLBACK_TO_GENERAL_COMMENT) {
        try {
          const generalComment = `Failed to post inline comment on ${comment.path}:${comment.line}.\n\n${comment.body}`;
          await octokit.issues.createComment({
            owner,
            repo,
            issue_number: pull_number,
            body: generalComment,
          });
        } catch (fallbackError) {
          const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          console.error(
            `Error creating fallback general comment:`,
            fallbackMessage
          );
          core.setFailed(`Failed to create fallback general comment: ${fallbackMessage}`);
        }
      }
    }
  }
}

function calculateTotalCost(): number {
  const pricing = pricingMap[config.OPENAI_API_MODEL];
  let totalCost = 0;
  if (pricing) {
    const costUncached = (accumulatedTokenUsage.uncachedTokens / 1_000_000) * pricing.uncachedInput;
    const costCached = (accumulatedTokenUsage.cachedTokens / 1_000_000) * pricing.cachedInput;
    const costOutput = (accumulatedTokenUsage.completionTokens / 1_000_000) * pricing.output;
    totalCost = costUncached + costCached + costOutput;
  } else {
    console.error(`No pricing information available for model: ${config.OPENAI_API_MODEL}`);
  }
  return totalCost;
}


async function main() {
  try {
      const prDetails = await getPRDetails();
      let diff: string | null = null; // Initialize diff to null
      const eventData = JSON.parse(
        readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
      );

      if (eventData.action === "opened") {
        diff = await getDiff(
          prDetails.owner,
          prDetails.repo,
          prDetails.pull_number
        );
      } else if (eventData.action === "synchronize") {
        const newBaseSha = eventData.before;
        const newHeadSha = eventData.after;

        const response = await octokit.repos.compareCommits({
          headers: {
            accept: "application/vnd.github.v3.diff",
          },
          owner: prDetails.owner,
          repo: prDetails.repo,
          base: newBaseSha,
          head: newHeadSha,
        });

        diff = String(response.data);
      } else {
        const unsupportedMessage = `Unsupported event: ${process.env.GITHUB_EVENT_NAME}`;
        console.error(unsupportedMessage);
        core.setFailed(unsupportedMessage);
        return; // Exit if the event is not supported
      }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  const filteredDiff = parsedDiff.filter((file) => {
    return !config.EXCLUDE_PATTERNS.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  const comments = await analyzeCode(filteredDiff, prDetails);
  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );
  }

    console.log("========= Summary ====================");
    console.log(`Total comments: ${comments.length}\n`);
    console.log(`Model: ${config.OPENAI_API_MODEL}`);

    const totalCost = calculateTotalCost();
    if (totalCost > 0) {
      console.log(`Uncached Input Tokens: ${accumulatedTokenUsage.uncachedTokens}`);
      console.log(`Cached Input Tokens: ${accumulatedTokenUsage.cachedTokens}`);
      console.log(`Output Tokens: ${accumulatedTokenUsage.completionTokens}`);
    }
    console.log(`Total Estimated Cost: $${totalCost.toFixed(3)}`);

    core.setOutput("commentsCount", comments.length);
    core.setOutput("totalCost", totalCost.toFixed(3));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(`Action failed: ${message}`);
    process.exit(1);
  }
}

main();
