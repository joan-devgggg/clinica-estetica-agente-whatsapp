export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

const secret = process.env.NEXT_PUBLIC_API_SECRET ?? "";

export function apiHeaders(orgId?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    ...(orgId ? { "X-Organization-Id": orgId } : {}),
  };
}
