// Vercel Serverless Function entrypoint for the Express app.
// Routes all requests through Express so it can serve static files from /Public
// and handle API endpoints (e.g. /api/*, /products, etc.).

const app = require("../server");

module.exports = (req, res) => app(req, res);
