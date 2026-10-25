import { NextResponse } from "next/server";
import { z } from "zod";
import { RecurrenceType, ReminderStatus } from "@prisma/client";
import { requireAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { prisma } from "@/lib/db";

const PatchSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  body: z.string().trim().max(2000).nullable().optional(),
  dueAt: z.string().min(1).optional(),
  status: z.nativeEnum(ReminderStatus).optional(),
  recurrenceType: z.nativeEnum(RecurrenceType).optional(),
  recurrenceWeekdays: z.array(z.number().int().min(0).max(6)).optional(),
  chatTargetId: z.string().nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).optional(),
});

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    await requireAuth();
    const { id } = await params;
    const body = PatchSchema.parse(await request.json());

    const data: Record<string, unknown> = {};
    if (body.title !== undefined) data.title = body.title;
    if (body.body !== undefined) data.body = body.body;
    if (body.status !== undefined) data.status = body.status;
    if (body.recurrenceType !== undefined) data.recurrenceType = body.recurrenceType;
    if (body.recurrenceWeekdays !== undefined) {
      data.recurrenceWeekdays = body.recurrenceWeekdays;
    }
    if (body.chatTargetId !== undefined) data.chatTargetId = body.chatTargetId;
    if (body.dueAt !== undefined) {
      const dueAt = new Date(body.dueAt);
      if (Number.isNaN(dueAt.getTime())) {
        return NextResponse.json({ error: "Invalid dueAt" }, { status: 400 });
      }
      data.dueAt = dueAt;
    }

    if (body.tags) {
      const unique = [...new Set(body.tags.map((n) => n.toLowerCase().trim()))];
      const tagRecords = [];
      for (const name of unique) {
        tagRecords.push(
          await prisma.tag.upsert({
            where: { name },
            create: { name, color: "#0f766e" },
            update: {},
          }),
        );
      }
      data.tags = { set: tagRecords.map((t) => ({ id: t.id })) };
    }

    const reminder = await prisma.reminder.update({
      where: { id },
      data,
      include: { chatTarget: true, tags: true },
    });

    return NextResponse.json({ reminder });
  } catch (error) {
    return jsonError(error, 400);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    await requireAuth();
    const { id } = await params;
    await prisma.reminder.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error, 400);
  }
}
