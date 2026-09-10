/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    // Internal loopback default — explicit IPv4, never dependent on
    // localhost address-family resolution; NEXT_PUBLIC_API_URL override
    // is preserved.
    const gatewayUrl = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:3000";
    return [
      {
        source: "/api/:path*",
        destination: `${gatewayUrl}/api/:path*`,
      },
      {
        source: "/health",
        destination: `${gatewayUrl}/health`,
      },
    ];
  },
};

module.exports = nextConfig;
