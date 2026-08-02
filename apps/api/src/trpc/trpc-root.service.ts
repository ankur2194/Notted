import { Injectable } from "@nestjs/common";

import { NotesTrpcRouter } from "../notes/notes.trpc";
import { WorkspacesTrpcRouter } from "../workspaces/workspaces.trpc";

import { createTrpcContext } from "./trpc.context";
import { trpc } from "./trpc.router";

import type { TrpcContext } from "./trpc.context";
import type { FolderSubrouter, NoteSubrouter } from "../notes/notes.trpc";
import type { WorkspaceTrpcSubrouter } from "../workspaces/workspaces.trpc";
import type { Request } from "express";

function buildRootRouter(
  workspace: WorkspaceTrpcSubrouter,
  note: NoteSubrouter,
  folder: FolderSubrouter,
) {
  return trpc.router({ workspace, note, folder });
}

export type AppRouter = ReturnType<typeof buildRootRouter>;

/** The one composable first-party router mounted once at /api/v1/trpc. */
@Injectable()
export class TrpcRootRouter {
  readonly router: AppRouter;

  constructor(workspaces: WorkspacesTrpcRouter, notes: NotesTrpcRouter) {
    this.router = buildRootRouter(workspaces.workspaceRouter, notes.noteRouter, notes.folderRouter);
  }

  createContext(request: Request): TrpcContext {
    return createTrpcContext(request);
  }
}
