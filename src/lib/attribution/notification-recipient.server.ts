import "server-only";
import { database } from "./store.server";
export async function currentNotificationRecipient(
  id: string,
  userId: string,
  email: string,
) {
  const sql = database();
  return sql.begin(async (tx) => {
    await tx`select set_config('maintaincode.organization_id',${id},true)`;
    await tx`select set_config('maintaincode.actor_id',${userId},true)`;
    const [result] =
      await tx`select public.maintaincode_notification_recipient_valid(${id}::uuid,${userId},${email}) as valid`;
    return result?.valid === true;
  }) as Promise<boolean>;
}
