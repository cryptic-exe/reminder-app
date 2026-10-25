import { NextResponse } from "next/server";
import { z } from "zod";
import { RecurrenceType } from "@prisma/client";
import { requireAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { prisma } from "@/lib/db";

const CreateSchema = z.object({
  title: z.string().trim().min(1).max(300),
  body: z.string().trim().max(2000).nullable().optional(),
  dueAt: z.string().min(1),
  rawInput: z.string().trim().min(1).max(2000),
  recurrenceType: z.nativeEnum(RecurrenceType).optional(),
  recurrenceWeekdays: z.array(z.number().int().min(0).max(6)).optional(),
  chatTargetId: z.string().nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).optional(),
});

export async function GET(request: Request) {
  try {
    await requireAuth();
    const url = new URL(request.url);
    const q = url.searchParams.get("q")?.trim();
    const tag = url.searchParams.get("tag")?.trim();
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");

    const reminders = await prisma.reminder.findMany({
      where: {
        AND: [
          q
            ? {
                OR: [
                  { title: { contains: q, mode: "insensitive" } },
                  { body: { contains: q, mode: "insensitive" } },
                  { rawInput: { contains: q, mode: "insensitive" } },
                ],
              }
            : {},
          tag
            ? { tags: { some: { name: tag.toLowerCase() } } }
            : {},
          from || to
            ? {
                dueAt: {
                  ...(from ? { gte: new Date(from) } : {}),
                  ...(to ? { lte: new Date(to) } : {}),
                },
              }
            : {},
        ],
      },
      include: { chatTarget: true, tags: true },
      orderBy: [{ dueAt: "asc" }],
    });
    return NextResponse.json({ reminders });
  } catch (error) {
    return jsonError(error);
  }
}

async function connectTags(names: string[]) {
  const unique = [...new Set(names.map((n) => n.toLowerCase().trim()).filter(Boolean))];
  const tags = [];
  for (const name of unique) {
    tags.push(
      await prisma.tag.upsert({
        where: { name },
        create: { name, color: "#0f766e" },
        update: {},
      }),
    );
  }
  return tags;
}

export async function POST(request: Request) {
  try {
    await requireAuth();
    const body = CreateSchema.parse(await request.json());
    const dueAt = new Date(body.dueAt);
    if (Number.isNaN(dueAt.getTime())) {
      return NextResponse.json({ error: "Invalid dueAt" }, { status: 400 });
    }

    const tagRecords = body.tags?.length ? await connectTags(body.tags) : [];

    const reminder = await prisma.reminder.create({
      data: {
        title: body.title,
        body: body.body ?? null,
        dueAt,
        rawInput: body.rawInput,
        status: "pending",
        recurrenceType: body.recurrenceType ?? "none",
        recurrenceWeekdays: body.recurrenceWeekdays ?? [],
        chatTargetId: body.chatTargetId ?? null,
        tags: tagRecords.length
          ? { connect: tagRecords.map((t) => ({ id: t.id })) }
          : undefined,
      },
      include: { chatTarget: true, tags: true },
    });

    return NextResponse.json({ reminder }, { status: 201 });
  } catch (error) {
    return jsonError(error, 400);
  }
}
