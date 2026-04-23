import { type RouteConfig, index, route, layout } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.tsx"),
  layout("routes/app.tsx", [
    route("dashboard", "routes/dashboard.tsx"),
    route("invoices", "routes/invoices.tsx"),
    route("invoices/:id", "routes/invoices.$id.tsx"),
    route("vendors", "routes/vendors.tsx"),
    route("vendors/new", "routes/vendors.new.tsx"),
    route("vendors/:id", "routes/vendors.$id.tsx"),
  ]),
] satisfies RouteConfig;
