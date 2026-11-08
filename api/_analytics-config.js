// Owner analytics dashboard: settings.
//
// To point this dashboard at a different client site, change the two IDs
// below OR set these environment variables in that site's Vercel project
// (Settings > Environment Variables). Environment variables win.
//
//   ANALYTICS_PROJECT_ID   Vercel project ID (or project name) to read
//   ANALYTICS_TEAM_ID      Vercel team ID that owns the project
//   ANALYTICS_SITE_NAME    Name shown at the top of the dashboard
//   KEY_PAGE_WORDS         Comma-separated words that mark a "key page"
//
// Secrets are NEVER stored here. They live only in Vercel env vars:
//   VERCEL_ANALYTICS_TOKEN  Vercel access token (read access is enough)
//   DASHBOARD_KEY           Private key the owner uses to open the page

export default {
  projectId: process.env.ANALYTICS_PROJECT_ID || 'prj_Fiu0LZ9MweAuP1NTE7mjd2nUTCph', // mikes-moving
  teamId: process.env.ANALYTICS_TEAM_ID || 'team_Cc0s2VxVYWX0IlXl7KuYBBNm',
  siteName: process.env.ANALYTICS_SITE_NAME || 'MJ Moving Company',
  keyPageWords: (process.env.KEY_PAGE_WORDS || 'quote,thank-you,contact,referral')
    .split(',')
    .map(function (w) { return w.trim().toLowerCase(); })
    .filter(Boolean),
};
