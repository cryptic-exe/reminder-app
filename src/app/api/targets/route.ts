import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { prisma } from "@/lib/db";

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  chatId: z.string().trim().min(5).max(80),
  isDefault: z.boolean().optional(),
});

export async function GET() {
  try {
    await requireAuth();
    const targets = await prisma.chatTarget.findMany({
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    });
    return NextResponse.json({ targets });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireAuth();
    const body = CreateSchema.parse(await request.json());

    if (body.isDefault) {
      await prisma.chatTarget.updateMany({ data: { isDefault: false } });
    }

    const target = await prisma.chatTarget.create({
      data: {
        name: body.name,
        chatId: body.chatId,
        isDefault: body.isDefault ?? false,
      },
    });
    return NextResponse.json({ target }, { status: 201 });
  } catch (error) {
    return jsonError(error, 400);
  }
}
