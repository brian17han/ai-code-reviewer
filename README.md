# AI Code Reviewer (Forked)

AI Code Reviewer is a GitHub Action that leverages OpenAI's API to provide intelligent feedback and suggestions on your pull requests. This powerful tool helps improve code quality and saves developers time by automating the code
review process.

This fork contains significant foundational changes from the original version.

## Features

- Reviews pull requests using OpenAI's API
- Provides intelligent comments and suggestions for improving your code
- Filters out files that match specified exclude patterns
- Easy to set up and integrate into your GitHub workflow
- Customizable AI model and prompt
- Fallback to general comment when inline comments fail
- Detailed cost breakdown and token usage statistics for supported models

## Contributors

This fork is maintained by [Brian Han](https://github.com/brian17han). It contains significant foundational changes from the original codebase, including:

- Complete rewrite of the core analysis logic
- Support for OpenAI's latest models with detailed cost tracking
- Enhanced error handling with fallback comment functionality
- Improved token usage and cost reporting

## Supported Models

Currently, the action provides cost calculations for the following models:
- `o3-mini-2025-01-31` (default)
- `gpt-4o-mini-2024-07-18`

## Setup

1. To use this GitHub Action, you need an OpenAI API key. If you don't have one, sign up for an API key
   at [OpenAI](https://beta.openai.com/signup).

2. Add the OpenAI API key as a GitHub Secret in your repository with the name `OPENAI_API_KEY`. You can find more
   information about GitHub Secrets [here](https://docs.github.com/en/actions/reference/encrypted-secrets).

3. Create a `.github/workflows/main.yml` file in your repository and add the following content:

```yaml
name: AI Code Reviewer

on:
  pull_request:
    types:
      - opened
      - synchronize
permissions: write-all
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Repo
        uses: actions/checkout@v3

      - name: AI Code Reviewer
        uses: {your_user_name}/ai-code-reviewer@main
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          OPENAI_API_MODEL: "o3-mini-2025-01-31" # Optional: defaults to "o3-mini-2025-01-31"
          EXCLUDE_PATTERNS: "**/*.json, **/*.md" # Optional: exclude patterns
          CUSTOM_PROMPT: "" # Optional: additional prompt for the AI
          FALLBACK_TO_GENERAL_COMMENT: "true" # Optional: fallback to general comment if inline comments fail
```

4. Replace `your_user_name` with your GitHub username or organization name where the AI Code Reviewer repository is located.

5. Customize the inputs if needed:

   - `OPENAI_API_MODEL`: Specify which OpenAI model to use. Supported models with cost calculation: "o3-mini-2025-01-31" (default) or "gpt-4o-mini-2024-07-18"
   - `EXCLUDE_PATTERNS`: Comma-separated glob patterns to exclude files from review
   - `CUSTOM_PROMPT`: Additional instructions for the AI reviewer
   - `FALLBACK_TO_GENERAL_COMMENT`: Whether to fallback to a general comment if inline commenting fails (default: true)

6. Commit the changes to your repository, and AI Code Reviewer will start working on your future pull requests.

## Outputs

The action provides the following outputs that can be used in subsequent workflow steps:

- `commentsCount`: The number of comments made by the AI
- `totalCost`: The total estimated cost of the API usage in USD

## How It Works

The AI Code Reviewer GitHub Action:

1. Retrieves the pull request diff
2. Filters out excluded files based on specified patterns
3. Sends code chunks to the OpenAI API for analysis
4. Generates review comments based on the AI's response
5. Posts comments to the pull request
6. If inline commenting fails and `FALLBACK_TO_GENERAL_COMMENT` is enabled, posts a general comment instead
7. Provides detailed cost breakdown and token usage statistics

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests to improve the AI Code Reviewer GitHub
Action.

Let the maintainer generate the final package (`yarn build` & `yarn package`).

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for more information.
