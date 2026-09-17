export default function PublicNoteNotFound() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto max-w-3xl p-8 text-center"
      role="alert"
    >
      <h1 className="text-3xl font-bold">This link doesn&apos;t work</h1>
      <p className="mt-2 text-muted-foreground">
        The link may have been revoked, or the note may no longer be shared.
      </p>
    </main>
  );
}
