import { NextResponse } from "next/server";
import { requireUser, badRequest } from "@/lib/api-helpers";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:fs";
import db from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;

  const { searchParams } = new URL(req.url);
  const faxId = searchParams.get("id");
  if (!faxId) return badRequest("Missing fax id");

  const fax = db
    .prepare("SELECT * FROM faxes WHERE id = ? AND user_id = ?")
    .get(faxId, user.id) as { file_path: string | null; file_type: string } | undefined;

  if (!fax?.file_path) {
    return NextResponse.json({ error: "Fax file not found" }, { status: 404 });
  }

  const filePath = fax.file_path.startsWith("/")
    ? fax.file_path
    : join(process.cwd(), "data", "faxes", fax.file_path);

  try {
    await access(filePath, constants.R_OK);
  } catch {
    return NextResponse.json({ error: "File not accessible" }, { status: 404 });
  }

  const buffer = await readFile(filePath);

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="fax_${faxId}.pdf"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
