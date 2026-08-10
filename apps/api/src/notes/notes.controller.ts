import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import {
  copyNoteSchema,
  createFolderSchema,
  createNoteSchema,
  deleteFolderSchema,
  deleteNoteSchema,
  folderListQuerySchema,
  moveNoteSchema,
  noteListQuerySchema,
  noteNavigationQuerySchema,
  permanentDeleteNoteSchema,
  restoreNoteSchema,
  updateFolderSchema,
  updateNoteSchema,
  uuidSchema,
} from "@notted/shared-validators";

import { getAuthPrincipal } from "../auth/auth-principal";
import { AuthService } from "../auth/auth.service";
import { RequireAuthorization } from "../authorization/authorization-http.decorator";
import { ApiHttpException } from "../common/errors/api-http.exception";
import { requireIdempotencyKey } from "../common/idempotency/api-idempotency";
import { getRequestId } from "../common/request/request-context";

import { NotesService } from "./notes.service";

import type {
  AuthenticatedPrincipal,
  FolderCreateResult,
  FolderDeleteResult,
  FolderPage,
  FolderUpdateResult,
  NoteCreateResult,
  NoteDeleteResult,
  NoteDetail,
  NoteMoveResult,
  NoteNavigation,
  NotePage,
  NotePermanentDeleteResult,
  NoteRestoreResult,
  NoteUpdateResult,
} from "@notted/shared-types";
import type { Request } from "express";

function routeUuid(request: Request, key: "workspaceId" | "noteId" | "folderId"): string {
  return uuidSchema.parse(request.params[key]);
}

const workspaceAuthorization = (action: "workspace.read" | "note.create" | "folder.create") => ({
  action,
  workspaceId: (request: Request) => routeUuid(request, "workspaceId"),
  resource: () => ({ kind: "workspace" as const }),
});

const noteAuthorization = (action: "note.read" | "note.update" | "note.delete") => ({
  action,
  workspaceId: (request: Request) => routeUuid(request, "workspaceId"),
  resource: (request: Request) => ({ kind: "note" as const, id: routeUuid(request, "noteId") }),
});

const folderAuthorization = (action: "folder.update" | "folder.delete") => ({
  action,
  workspaceId: (request: Request) => routeUuid(request, "workspaceId"),
  resource: (request: Request) => ({ kind: "folder" as const, id: routeUuid(request, "folderId") }),
});

@Controller("workspaces/:workspaceId/notes")
export class NotesController {
  constructor(
    private readonly notes: NotesService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  @RequireAuthorization(workspaceAuthorization("workspace.read"))
  list(@Req() request: Request, @Query() rawQuery: unknown): Promise<NotePage> {
    const query = noteListQuerySchema.safeParse(rawQuery);
    if (!query.success) this.invalid();
    return this.notes.list({
      ...this.scope(request),
      page: query.data.page,
      limit: query.data.limit,
      scope: query.data.scope,
      projectId: query.data.projectId,
      folderId: query.data.folderId,
      rootFolder: query.data.rootFolder,
      parentId: query.data.parentId,
      rootParent: query.data.rootParent,
      type: query.data.type,
      view: query.data.view,
      isTemplate: query.data.isTemplate,
      isPinned: query.data.isPinned,
      isArchived: query.data.isArchived,
      tagId: query.data.tagId,
      sortBy: query.data.sortBy,
      sortDirection: query.data.sortDirection,
    });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireAuthorization(workspaceAuthorization("note.create"))
  create(@Req() request: Request, @Body() rawBody: unknown): Promise<NoteCreateResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = createNoteSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.notes.create({
      ...this.scope(request),
      title: body.data.title,
      projectId: body.data.projectId ?? null,
      folderId: body.data.folderId ?? null,
      parentId: body.data.parentId ?? null,
      type: body.data.type,
      pageSize: body.data.pageSize,
      isTemplate: body.data.isTemplate,
      isPinned: body.data.isPinned,
      isArchived: body.data.isArchived,
      tagIds: body.data.tagIds,
      content: body.data.content,
      idempotencyKey: requireIdempotencyKey(request),
    });
  }

  @Get("navigation")
  @RequireAuthorization(workspaceAuthorization("workspace.read"))
  navigation(@Req() request: Request, @Query() rawQuery: unknown): Promise<NoteNavigation> {
    const query = noteNavigationQuerySchema.safeParse(rawQuery);
    if (!query.success) this.invalid();
    return this.notes.navigation({ ...this.scope(request), ...query.data });
  }

  @Get(":noteId")
  @RequireAuthorization(noteAuthorization("note.read"))
  read(@Req() request: Request): Promise<NoteDetail> {
    return this.notes.read(this.noteScope(request));
  }

  @Patch(":noteId")
  @RequireAuthorization(noteAuthorization("note.update"))
  update(@Req() request: Request, @Body() rawBody: unknown): Promise<NoteUpdateResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = updateNoteSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.notes.update({ ...this.noteScope(request), ...body.data });
  }

  @Delete(":noteId")
  @RequireAuthorization(noteAuthorization("note.delete"))
  softDelete(@Req() request: Request, @Body() rawBody: unknown): Promise<NoteDeleteResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = deleteNoteSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.notes.softDelete({ ...this.noteScope(request), ...body.data });
  }

  @Post(":noteId/move")
  @RequireAuthorization(noteAuthorization("note.update"))
  move(@Req() request: Request, @Body() rawBody: unknown): Promise<NoteMoveResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = moveNoteSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.notes.move({ ...this.noteScope(request), ...body.data });
  }

  // The decorator authorizes `note.read` on the SOURCE note — the resource the
  // URL names. The destination `note.create` check runs inside the service,
  // the only place the destination container is known.
  @Post(":noteId/copy")
  @HttpCode(HttpStatus.CREATED)
  @RequireAuthorization(noteAuthorization("note.read"))
  copy(@Req() request: Request, @Body() rawBody: unknown): Promise<NoteCreateResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = copyNoteSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.notes.copy({
      ...this.noteScope(request),
      asTemplate: body.data.asTemplate,
      includeTags: body.data.includeTags,
      title: body.data.title,
      projectId: body.data.projectId ?? null,
      folderId: body.data.folderId ?? null,
      parentId: body.data.parentId ?? null,
      idempotencyKey: requireIdempotencyKey(request),
    });
  }

  @Post(":noteId/restore")
  @RequireAuthorization(noteAuthorization("note.update"))
  restore(@Req() request: Request, @Body() rawBody: unknown): Promise<NoteRestoreResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = restoreNoteSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.notes.restore({ ...this.noteScope(request), ...body.data });
  }

  @Post(":noteId/permanent-delete")
  @RequireAuthorization(noteAuthorization("note.delete"))
  permanentDelete(
    @Req() request: Request,
    @Body() rawBody: unknown,
  ): Promise<NotePermanentDeleteResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = permanentDeleteNoteSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.notes.permanentDelete({
      ...this.noteScope(request),
      expectedVersion: body.data.expectedVersion,
      expectedTitle: body.data.expectedTitle,
    });
  }

  private scope(request: Request) {
    return {
      principal: this.principal(request),
      workspaceId: routeUuid(request, "workspaceId"),
      requestId: getRequestId(request) ?? null,
    };
  }

  private noteScope(request: Request) {
    return { ...this.scope(request), noteId: routeUuid(request, "noteId") };
  }

  private principal(request: Request): AuthenticatedPrincipal {
    const principal = getAuthPrincipal(request);
    if (principal === undefined) throw new Error("Authorization guard did not attach a principal");
    return principal;
  }

  private invalid(): never {
    throw new ApiHttpException(HttpStatus.BAD_REQUEST, {
      code: "VALIDATION_ERROR",
      message: "The request is invalid.",
    });
  }
}

@Controller("workspaces/:workspaceId/folders")
export class FoldersController {
  constructor(
    private readonly notes: NotesService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  @RequireAuthorization(workspaceAuthorization("workspace.read"))
  list(@Req() request: Request, @Query() rawQuery: unknown): Promise<FolderPage> {
    const query = folderListQuerySchema.safeParse(rawQuery);
    if (!query.success) this.invalid();
    return this.notes.listFolders({ ...this.scope(request), ...query.data });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireAuthorization(workspaceAuthorization("folder.create"))
  create(@Req() request: Request, @Body() rawBody: unknown): Promise<FolderCreateResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = createFolderSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.notes.createFolder({ ...this.scope(request), ...body.data });
  }

  @Patch(":folderId")
  @RequireAuthorization(folderAuthorization("folder.update"))
  update(@Req() request: Request, @Body() rawBody: unknown): Promise<FolderUpdateResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = updateFolderSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.notes.updateFolder({
      ...this.scope(request),
      folderId: routeUuid(request, "folderId"),
      ...body.data,
    });
  }

  @Delete(":folderId")
  @RequireAuthorization(folderAuthorization("folder.delete"))
  delete(@Req() request: Request, @Body() rawBody: unknown): Promise<FolderDeleteResult> {
    this.auth.assertTrustedMutationOrigin(request);
    const body = deleteFolderSchema.safeParse(rawBody);
    if (!body.success) this.invalid();
    return this.notes.deleteFolder({
      ...this.scope(request),
      folderId: routeUuid(request, "folderId"),
    });
  }

  private scope(request: Request) {
    const principal = getAuthPrincipal(request);
    if (principal === undefined) throw new Error("Authorization guard did not attach a principal");
    return {
      principal,
      workspaceId: routeUuid(request, "workspaceId"),
      requestId: getRequestId(request) ?? null,
    };
  }

  private invalid(): never {
    throw new ApiHttpException(HttpStatus.BAD_REQUEST, {
      code: "VALIDATION_ERROR",
      message: "The request is invalid.",
    });
  }
}
