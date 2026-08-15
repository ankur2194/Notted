import { Injectable } from "@nestjs/common";

import { CommentsTrpcRouter } from "../comments/comments.trpc";
import { NotesTrpcRouter } from "../notes/notes.trpc";
import { TagsTrpcRouter } from "../tags/tags.trpc";
import { TasksTrpcRouter } from "../tasks/tasks.trpc";
import { WorkspacesTrpcRouter } from "../workspaces/workspaces.trpc";

import { createTrpcContext } from "./trpc.context";
import { trpc } from "./trpc.router";

import type { TrpcContext } from "./trpc.context";
import type { CommentSubrouter } from "../comments/comments.trpc";
import type { FolderSubrouter, NoteSubrouter } from "../notes/notes.trpc";
import type { TagSubrouter } from "../tags/tags.trpc";
import type { TaskSubrouter } from "../tasks/tasks.trpc";
import type { WorkspaceTrpcSubrouter } from "../workspaces/workspaces.trpc";
import type { Request } from "express";

function buildRootRouter(
  workspace: WorkspaceTrpcSubrouter,
  note: NoteSubrouter,
  folder: FolderSubrouter,
  tag: TagSubrouter,
  task: TaskSubrouter,
  comment: CommentSubrouter,
) {
  return trpc.router({ workspace, note, folder, tag, task, comment });
}

export type AppRouter = ReturnType<typeof buildRootRouter>;

/** The one composable first-party router mounted once at /api/v1/trpc. */
@Injectable()
export class TrpcRootRouter {
  readonly router: AppRouter;

  constructor(
    workspaces: WorkspacesTrpcRouter,
    notes: NotesTrpcRouter,
    tags: TagsTrpcRouter,
    tasks: TasksTrpcRouter,
    comments: CommentsTrpcRouter,
  ) {
    this.router = buildRootRouter(
      workspaces.workspaceRouter,
      notes.noteRouter,
      notes.folderRouter,
      tags.tagRouter,
      tasks.taskRouter,
      comments.commentRouter,
    );
  }

  createContext(request: Request): TrpcContext {
    return createTrpcContext(request);
  }
}
