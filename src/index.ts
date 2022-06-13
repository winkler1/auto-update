import {
  getInput,
  group,
  info,
  error as logError,
  setFailed,
  warning,
} from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { GitHub } from "@actions/github/lib/utils";
import type { components } from "@octokit/openapi-types";
import type { PushEvent } from "@octokit/webhooks-definitions/schema";

var scheduledUpdates = 0;
const MAX_SCHEDULED_UPDATES = 2;

const handleError = (
  error: unknown,
  {
    handle = logError,
  }: Readonly<{ handle?: (error: string | Error) => void }> = {},
) => {
  if (typeof error !== "string" && !(error instanceof Error)) {
    throw new TypeError(`Caught error of unexpected type: ${typeof error}`);
  }

  handle(error);
  setFailed(error);
};

const unupdatablePullRequestCommentBody =
  "Cannot auto-update because of conflicts.";

const handleUnupdatablePullRequest = async (
  pullRequest: components["schemas"]["pull-request-simple"],
  {
    octokit,
  }: Readonly<{
    octokit: InstanceType<typeof GitHub>;
  }>,
): Promise<void> => {
  try {
    const {
      head: {
        repo: { full_name },
        sha,
      },
      number,
    } = pullRequest;

    const [owner, repo] = full_name.split("/");

    const {
      data: { commit: lastCommit },
    } = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
      owner,
      ref: sha,
      repo,
    });

    const lastCommitter = lastCommit.committer;

    if (!lastCommitter) {
      throw new Error(`Missing committer on last commit ${sha}`);
    }

    const comments = await octokit.paginate(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        ...context.repo,
        issue_number: number,
        since: lastCommitter.date,
      },
    );

    const existingUnupdatablePullRequestComment = comments.find(
      ({ body }) => body === unupdatablePullRequestCommentBody,
    );

    if (existingUnupdatablePullRequestComment) {
      info(
        `Already commented since last commit: ${existingUnupdatablePullRequestComment.html_url}`,
      );
      return;
    }

    const { data: newComment } = await octokit.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        ...context.repo,
        body: unupdatablePullRequestCommentBody,
        issue_number: number,
      },
    );

    info(`Commented: ${newComment.html_url}`);
  } catch (error: unknown) {
    handleError(error, { handle: warning });
  }
};

const handlePullRequest = async (
  pullRequest: components["schemas"]["pull-request-simple"],
  {
    eventPayload,
    octokit,
  }: Readonly<{
    eventPayload: PushEvent;
    octokit: InstanceType<typeof GitHub>;
  }>,
): Promise<void> => {
  if (!pullRequest.auto_merge) {
    info(
      `Pull request #${pullRequest.number} does not have auto-merge enabled`,
    );
    return;
  }

  if (pullRequest.base.sha === eventPayload.after) {
    info(`Pull request #${pullRequest.number} is already up to date`);
    return;
  }

  await group(
    `Attempting to update pull request #${pullRequest.number}`,
    async () => {
      ++scheduledUpdates;
      try {
        await octokit.request(
          "PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch",
          {
            ...context.repo,
            // See https://docs.github.com/en/free-pro-team@latest/rest/reference/pulls#update-a-pull-request-branch-preview-notices.
            mediaType: {
              previews: ["lydian"],
            },
            pull_number: pullRequest.number,
          },
        );
        info("Updated!");
      } catch (error: unknown) {
        handleError(error, { handle: warning });
        await handleUnupdatablePullRequest(pullRequest, { octokit });
      }
    },
  );
};

const run = async () => {
  info("---- latest code.")
  try {
    const localDateString = new Date().toLocaleString("en-US", {
      timeZone: "America/New_York",
    });
    const localDate = new Date(localDateString);
    const localDayIndex = localDate.getDay();

    const fridayIndex = 5;
    const saturdayIndex = 6;
    const sundayIndex = 0;

    if ([fridayIndex, saturdayIndex, sundayIndex].includes(localDayIndex)) {
      // info("Skipping auto-update on Friday-Sunday in NY");
      // return;
    }

    const token = getInput("github_token", { required: true });
    const octokit = getOctokit(token);

    if (context.eventName !== "push") {
      throw new Error(
        `Expected to be triggered by a "push" event but received a "${context.eventName}" event`,
      );
    }

    const eventPayload = context.payload as PushEvent;
    // See https://docs.github.com/en/free-pro-team@latest/developers/webhooks-and-events/webhook-events-and-payloads#webhook-payload-object-34.
    const base = eventPayload.ref.slice("refs/heads/".length);

    info(`Fetching pull requests based on "${base}"`);

    const pullRequests = await octokit.paginate(
      "GET /repos/{owner}/{repo}/pulls",
      {
        ...context.repo,
        base,
        direction: "desc",
        sort: "updated",
        state: "open",
      },
    );

    info(
      `Fetched pull requests: ${JSON.stringify(
        pullRequests.map((pullRequest) => pullRequest.number),
      )}`,
    );

    const autoMergeEnabledPullRequests = pullRequests.filter(
      (pullRequest) => pullRequest.auto_merge,
    );

    info(
      `auto-merge-enabled pull requests: ${JSON.stringify(
        autoMergeEnabledPullRequests.map((pullRequest) => pullRequest.number),
      )}`,
    );

    const developerPullRequests = autoMergeEnabledPullRequests.filter(
      (pullRequest) => pullRequest.user?.login !== "dependabot[bot]",
    );

    info(
      `developer pull requests: ${JSON.stringify(
        developerPullRequests.map((pullRequest) => pullRequest.number),
      )}`,
    );

    for (const pullRequest of developerPullRequests) {
      // PRs are handled sequentially to avoid breaking GitHub's log grouping feature.
      // eslint-disable-next-line no-await-in-loop
      await handlePullRequest(pullRequest, { eventPayload, octokit });
      if (scheduledUpdates >= MAX_SCHEDULED_UPDATES) {
        return;
      };
    }

    const dependabotPullRequests = autoMergeEnabledPullRequests.filter(
      (pullRequest) => pullRequest.user?.login === "dependabot[bot]",
    );

    info(
      `dependabot pull requests: ${JSON.stringify(
        dependabotPullRequests.map((pullRequest) => pullRequest.number),
      )}`,
    );

    for (const pullRequest of dependabotPullRequests) {
      // PRs are handled sequentially to avoid breaking GitHub's log grouping feature.
      // eslint-disable-next-line no-await-in-loop
      await handlePullRequest(pullRequest, { eventPayload, octokit });
      if (scheduledUpdates >= MAX_SCHEDULED_UPDATES) {
        return;
      };
    }
  } catch (error: unknown) {
    handleError(error, { handle: setFailed });
  }
};

void run();
