import { LoginForm } from "@/components/auth/login-form";

/**
 * Non-functional authentication scaffold at `/login`.
 *
 * The heading, availability notice, and disabled controls render on the server.
 *
 * Real authentication with Better Auth is wired in Part 22. There is no
 * "Sign up" link yet because the `/register` route does not exist.
 */
export default function LoginPage() {
  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center space-y-4">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Sign in</h1>
          <p className="text-muted-foreground">Authentication controls are shown as a preview.</p>
        </div>

        <LoginForm />

        <div
          id="login-availability"
          className="rounded-lg bg-muted p-4 text-center text-sm text-muted-foreground"
        >
          <strong className="text-foreground">Unavailable:</strong> Credential and OAuth sign-in
          will be implemented with authentication in Part 22.
        </div>
      </div>
    </div>
  );
}
