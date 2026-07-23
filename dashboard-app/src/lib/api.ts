export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export function apiHeaders(extra?: Record<string, string>): Record<string, string> {
  const secret = process.env.NEXT_PUBLIC_API_SECRET ?? "";
  return {
    "Content-Type": "application/json",
    ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    ...extra,
  };
}
