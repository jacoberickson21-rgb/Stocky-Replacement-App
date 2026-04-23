import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("login", "routes/login.tsx"),
  route("dashboard", "routes/dashboard.tsx"),
  route("logout", "routes/logout.tsx"),
  route("vendors", "routes/vendors.tsx"),
  route("vendors/new", "routes/vendors.new.tsx"),
  route("vendors/:id", "routes/vendors.$id.tsx"),
] satisfies RouteConfig;
