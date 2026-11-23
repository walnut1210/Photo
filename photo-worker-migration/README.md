# Photo Timelapse — Cloudflare Workers

The existing `public/index.html` frontend is copied unchanged.

## Setup
1. Install Node.js and run `npm install`.
2. Use this directory with Wrangler.
3. Set the Discord webhook as a Worker secret: `npx wrangler secret put DISCORD_WEBHOOK_URL`.
4. Run `npm run dev` to test locally.
5. Deploy with `npm run deploy`.

## API compatibility
`/api/timelapse/start`, `/begin`, `/frame`, `/finish`, and `/status/:sessionId` are retained.

## Notes
- Session state is stored using a Durable Object.
- Discord uploads use direct HTTPS; proxy routing has been removed.
- If upload fails, the batch is retained in Durable Object storage. Automatic retry scheduling is not implemented.
- Configure Durable Objects and Workers Assets in `wrangler.toml`.
