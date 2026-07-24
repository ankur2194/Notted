/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@notted/shared-types", "@notted/shared-validators"],
};

module.exports = nextConfig;
