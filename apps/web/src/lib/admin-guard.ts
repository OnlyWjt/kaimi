import { requireAdmin, type AuthSession } from "@/lib/auth";

export async function authorizeAdmin(): Promise<
  { session: AuthSession; error: null } | { session: null; error: Response }
> {
  try {
    return { session: await requireAdmin(), error: null };
  } catch (error) {
    if (error instanceof Response) return { session: null, error };
    throw error;
  }
}
