import { failure, json, productContext } from "@/lib/product/api";
import { describeHandlers } from "@/lib/tasks/handlers";

export async function GET() {
  try {
    await productContext();
    return json({ kinds: describeHandlers() });
  } catch (error) {
    return failure(error);
  }
}
