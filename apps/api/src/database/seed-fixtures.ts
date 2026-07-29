/**
 * Stable identifiers and public scenario labels for the Part 20 development
 * seed. These values are safe to import from integration tests. They are not
 * authentication claims or credentials.
 */
export const SEED_SCENARIOS = {
  alpha: {
    label: "Alpha isolation tenant",
    workspaceName: "Notted Alpha Studio",
    workspaceSlug: "notted-seed-alpha",
  },
  beta: {
    label: "Beta isolation tenant",
    workspaceName: "Notted Beta Workshop",
    workspaceSlug: "notted-seed-beta",
  },
} as const;

export const SEED_IDENTITIES = {
  alphaOwner: {
    id: "20000000-0000-4000-8000-000000000001",
    label: "Alpha Owner",
    email: "alpha.owner@notted.test",
  },
  alphaAdmin: {
    id: "20000000-0000-4000-8000-000000000002",
    label: "Alpha Admin",
    email: "alpha.admin@notted.test",
  },
  alphaEditor: {
    id: "20000000-0000-4000-8000-000000000003",
    label: "Alpha Editor",
    email: "alpha.editor@notted.test",
  },
  alphaViewer: {
    id: "20000000-0000-4000-8000-000000000004",
    label: "Alpha Viewer",
    email: "alpha.viewer@notted.test",
  },
  betaOwner: {
    id: "20000000-0000-4000-8000-000000000005",
    label: "Beta Owner",
    email: "beta.owner@notted.test",
  },
  betaEditor: {
    id: "20000000-0000-4000-8000-000000000006",
    label: "Beta Editor",
    email: "beta.editor@notted.test",
  },
} as const;

export const SEED_IDS = {
  users: {
    alphaOwner: SEED_IDENTITIES.alphaOwner.id,
    alphaAdmin: SEED_IDENTITIES.alphaAdmin.id,
    alphaEditor: SEED_IDENTITIES.alphaEditor.id,
    alphaViewer: SEED_IDENTITIES.alphaViewer.id,
    betaOwner: SEED_IDENTITIES.betaOwner.id,
    betaEditor: SEED_IDENTITIES.betaEditor.id,
  },
  workspaces: {
    alpha: "20000000-0000-4000-8100-000000000001",
    beta: "20000000-0000-4000-8100-000000000002",
  },
  memberships: {
    alphaOwner: "20000000-0000-4000-8200-000000000001",
    alphaAdmin: "20000000-0000-4000-8200-000000000002",
    alphaEditor: "20000000-0000-4000-8200-000000000003",
    alphaViewer: "20000000-0000-4000-8200-000000000004",
    betaOwner: "20000000-0000-4000-8200-000000000005",
    betaEditor: "20000000-0000-4000-8200-000000000006",
  },
  projects: {
    alphaLaunch: "20000000-0000-4000-8300-000000000001",
    alphaOperations: "20000000-0000-4000-8300-000000000002",
    betaResearch: "20000000-0000-4000-8300-000000000003",
  },
  folders: {
    alphaHandbook: "20000000-0000-4000-8400-000000000001",
    alphaPlaybooks: "20000000-0000-4000-8400-000000000002",
    betaLibrary: "20000000-0000-4000-8400-000000000003",
  },
  notes: {
    alphaPinnedRoot: "20000000-0000-4000-8500-000000000001",
    alphaProjectOverview: "20000000-0000-4000-8500-000000000002",
    alphaProjectChild: "20000000-0000-4000-8500-000000000003",
    alphaFolderNote: "20000000-0000-4000-8500-000000000004",
    alphaTemplate: "20000000-0000-4000-8500-000000000005",
    alphaDeleted: "20000000-0000-4000-8500-000000000006",
    alphaTaskNote: "20000000-0000-4000-8500-000000000007",
    betaRoot: "20000000-0000-4000-8500-000000000008",
    betaProjectNote: "20000000-0000-4000-8500-000000000009",
  },
  tags: {
    alphaPlanning: "20000000-0000-4000-8600-000000000001",
    alphaUrgent: "20000000-0000-4000-8600-000000000002",
    betaResearch: "20000000-0000-4000-8600-000000000003",
  },
  comments: {
    alphaThread: "20000000-0000-4000-8700-000000000001",
    alphaReply: "20000000-0000-4000-8700-000000000002",
  },
  noteVersions: {
    alphaOverviewV1: "20000000-0000-4000-8800-000000000001",
    alphaOverviewV2: "20000000-0000-4000-8800-000000000002",
    alphaOverviewV3: "20000000-0000-4000-8800-000000000003",
  },
  attachments: {
    alphaBrief: "20000000-0000-4000-8900-000000000001",
  },
  taskStatuses: {
    alphaReview: "20000000-0000-4000-8a00-000000000001",
  },
  tasks: {
    alphaPrepareLaunch: "20000000-0000-4000-8b00-000000000001",
    alphaConfirmCopy: "20000000-0000-4000-8b00-000000000002",
    alphaPublishNotes: "20000000-0000-4000-8b00-000000000003",
    alphaStandaloneFollowUp: "20000000-0000-4000-8b00-000000000004",
  },
} as const;

export const SEED_TIMESTAMPS = {
  created: "2026-01-05T09:00:00.000Z",
  updated: "2026-01-12T16:30:00.000Z",
  deleted: "2026-01-10T12:00:00.000Z",
  version1: "2026-01-06T09:00:00.000Z",
  version2: "2026-01-08T11:00:00.000Z",
  version3: "2026-01-12T16:30:00.000Z",
  dueSoon: "2026-02-02T15:00:00.000Z",
  dueLater: "2026-02-09T17:00:00.000Z",
  completed: "2026-01-11T14:00:00.000Z",
} as const;

export const RICH_TIPTAP_DOCUMENT = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 1 },
      content: [{ type: "text", text: "Quarterly planning" }],
    },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Alpha prepares a focused launch with measurable outcomes." },
      ],
    },
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Goals" }],
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Ship a clear onboarding path" }],
            },
          ],
        },
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Confirm workspace isolation" }] },
          ],
        },
      ],
    },
    {
      type: "orderedList",
      attrs: { start: 1 },
      content: [
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Draft the launch brief" }] },
          ],
        },
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Review it with the team" }] },
          ],
        },
      ],
    },
    {
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { checked: false },
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Prepare release brief" }] },
          ],
        },
        {
          type: "taskItem",
          attrs: { checked: true },
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Publish decision log" }] },
          ],
        },
      ],
    },
    {
      type: "blockquote",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Decisions stay visible and actionable." }],
        },
      ],
    },
  ],
} as const;

export const RICH_CONTENT_PLAIN = [
  "Quarterly planning",
  "Alpha prepares a focused launch with measurable outcomes.",
  "Goals",
  "Ship a clear onboarding path",
  "Confirm workspace isolation",
  "Draft the launch brief",
  "Review it with the team",
  "Prepare release brief",
  "Publish decision log",
  "Decisions stay visible and actionable.",
].join("\n");

export const TASK_TIPTAP_DOCUMENT = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Launch checklist" }],
    },
    {
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { checked: false },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Prepare launch" }] }],
        },
      ],
    },
  ],
} as const;

export const TASK_CONTENT_PLAIN = "Launch checklist\nPrepare launch";

export const SEED_EXPECTED_COUNTS = {
  users: 6,
  workspaces: 2,
  workspaceMembers: 6,
  projects: 3,
  folders: 3,
  notes: 9,
  tags: 3,
  noteTags: 4,
  comments: 2,
  noteVersions: 3,
  attachments: 1,
  taskStatuses: 1,
  tasks: 4,
  taskTags: 2,
} as const;

export type SeedCountName = keyof typeof SEED_EXPECTED_COUNTS;
