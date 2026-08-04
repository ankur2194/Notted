/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@notted/shared-types", "@notted/shared-validators"],
  // Development only. Next blocks cross-origin access to `/_next/*` dev
  // resources and allows `localhost` alone by default, so opening the app on
  // any other loopback spelling — `http://127.0.0.1:3000`, which is what the
  // Docker Desktop port link and `compose.yaml`'s `127.0.0.1:` publish address
  // both show — gets its HMR socket blocked. Turbopack's client runtime waits
  // on that socket, so hydration never completes and every form silently falls
  // back to a native GET submit that reloads the page with the field values in
  // the URL. These are loopback addresses for the same machine, so allowing
  // them grants no reach a `localhost` visitor does not already have.
  allowedDevOrigins: ["127.0.0.1", "[::1]"],
};

module.exports = nextConfig;
