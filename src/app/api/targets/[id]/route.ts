import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { prisma } from "@/lib/db";

const PatchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  chatId: z.string().trim().min(5).max(80).optional(),
  isDefault: z.boolean().optional(),
});

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    await requireAuth();
    const { id } = await params;
    const body = PatchSchema.parse(await request.json());
    if (body.isDefault) {
      await prisma.chatTarget.updateMany({ data: { isDefault: false } });
    }
    const target = await prisma.chatTarget.update({
      where: { id },
      data: body,
    });
    return NextResponse.json({ target });
  } catch (error) {
    return jsonError(error, 400);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    await requireAuth();
    const { id } = await params;
    await prisma.chatTarget.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error, 400);
  }
}
