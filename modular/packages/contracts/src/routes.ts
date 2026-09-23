/** Extension-owned HTTP manifest. Native clients and native routes are not generated or modified here. */
export const routes = {
  layout: { method: "GET", path: "/api/cybermastery/layout" },
  save: { method: "PUT", path: "/api/cybermastery/layout" },
  events: { method: "GET", path: "/api/cybermastery/events" },
} as const
