import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { prisma } from "@/lib/db";

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: z.string().trim().min(4).max(20).optional(),
});

export async function GET() {
  try {
    await requireAuth();
    const tags = await prisma.tag.findMany({ orderBy: { name: "asc" } });
    return NextResponse.json({ tags });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireAuth();
    const body = CreateSchema.parse(await request.json());
    const tag = await prisma.tag.upsert({
      where: { name: body.name.toLowerCase() },
      create: {
        name: body.name.toLowerCase(),
        color: body.color || "#0f766e",
      },
      update: body.color ? { color: body.color } : {},
    });
    return NextResponse.json({ tag }, { status: 201 });
  } catch (error) {
    return jsonError(error, 400);
  }
}
