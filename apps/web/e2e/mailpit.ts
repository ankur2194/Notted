import { expect, type APIRequestContext } from "@playwright/test";

const mailpitUrl = process.env.PLAYWRIGHT_MAILPIT_URL ?? "http://localhost:8025";

interface MailpitMessageSummary {
  readonly ID: string;
  readonly Subject?: string;
  readonly To?: readonly { readonly Address?: string }[];
}

interface MailpitList {
  readonly messages?: readonly MailpitMessageSummary[];
}

interface MailpitMessage {
  readonly HTML?: string;
  readonly Text?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseList(value: unknown): MailpitList {
  if (!isObject(value) || !Array.isArray(value.messages)) return {};
  return { messages: value.messages as readonly MailpitMessageSummary[] };
}

function parseMessage(value: unknown): MailpitMessage {
  if (!isObject(value)) return {};
  return {
    HTML: typeof value.HTML === "string" ? value.HTML : undefined,
    Text: typeof value.Text === "string" ? value.Text : undefined,
  };
}

export async function clearMailpit(request: APIRequestContext): Promise<void> {
  const response = await request.delete(`${mailpitUrl}/api/v1/messages`);
  expect(response.ok()).toBeTruthy();
}

export async function latestActionLink(
  request: APIRequestContext,
  recipient: string,
  subjectIncludes?: string,
): Promise<string> {
  let messageId: string | undefined;

  await expect
    .poll(
      async () => {
        const response = await request.get(`${mailpitUrl}/api/v1/messages`);
        if (!response.ok()) return false;
        const list = parseList(await response.json());
        const message = list.messages?.find(
          (candidate) =>
            candidate.To?.some((to) => to.Address?.toLowerCase() === recipient.toLowerCase()) &&
            (subjectIncludes === undefined ||
              candidate.Subject?.includes(subjectIncludes) === true),
        );
        messageId = message?.ID;
        return messageId !== undefined;
      },
      { timeout: 20_000, message: `waiting for authentication mail to ${recipient}` },
    )
    .toBe(true);

  if (messageId === undefined) throw new Error("Mailpit polling completed without a message id");
  const response = await request.get(`${mailpitUrl}/api/v1/message/${messageId}`);
  expect(response.ok()).toBeTruthy();
  const message = parseMessage(await response.json());
  const content = `${message.Text ?? ""}\n${message.HTML ?? ""}`.replaceAll("&amp;", "&");
  const match = content.match(/https?:\/\/[^\s"'<>]+/u);
  if (match === null) throw new Error("Authentication message did not contain an action link");
  return match[0];
}
