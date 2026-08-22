import { z } from "zod";

export const batchNumberSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{6}$/, "Batch number must be exactly 6 digits");

/** Student registration: name + 6-digit batch number only. */
export const registrationSchema = z.object({
  fullName: z.string().trim().min(2, "Full name is required").max(120),
  batchNumber: batchNumberSchema,
});
export type RegistrationInput = z.infer<typeof registrationSchema>;

/** Single sign-in form: batch number (students) or email (admins). */
export const signInSchema = z.object({
  identifier: z.string().trim().min(3, "Enter your batch number or email").max(255),
  password: z.string().min(6, "Password must be at least 6 characters").max(128),
});
export type SignInInput = z.infer<typeof signInSchema>;


export const profileSchema = z.object({
  fullName: z.string().trim().min(2, "Full name is required").max(120),
  phone: z.string().trim().max(20),
});

export const batchSchema = z.object({
  batchNumber: batchNumberSchema,
  name: z.string().trim().max(120),
  department: z.string().trim().max(120),
  academicYear: z.string().trim().max(40),
  active: z.boolean(),
});

export const eventSchema = z.object({
  name: z.string().trim().min(2, "Event name is required").max(160),
  description: z.string().trim().max(2000),
  startAt: z.string().optional().nullable(),
  endAt: z.string().optional().nullable(),
  status: z.enum(["draft", "upcoming", "active", "completed"]),
  maxParticipants: z.coerce.number().int().min(1).max(100000),
  resultsPublished: z.boolean(),
});

export const roundSchema = z.object({
  eventId: z.string().uuid(),
  name: z.string().trim().min(2, "Round name is required").max(160),
  description: z.string().trim().max(2000),
  orderIndex: z.coerce.number().int().min(1).max(100),
  roundType: z.enum(["mcq", "coding"]),
  durationMinutes: z.coerce.number().int().min(1).max(1440),
  maxMarks: z.coerce.number().int().min(1).max(10000),
  startAt: z.string().optional().nullable(),
  endAt: z.string().optional().nullable(),
  enabled: z.boolean(),
  status: z.enum(["upcoming", "live", "completed", "locked"]),
});

export const questionSchema = z.object({
  roundId: z.string().uuid(),
  questionText: z.string().trim().min(3, "Question text is required").max(4000),
  marks: z.coerce.number().int().min(1).max(1000),
  orderIndex: z.coerce.number().int().min(1).max(1000),
  explanation: z.string().trim().max(2000),
  visible: z.boolean(),
  options: z
    .array(
      z.object({
        id: z.string().uuid().optional(),
        optionText: z.string().trim().min(1, "Option text is required").max(1000),
        isCorrect: z.boolean(),
      }),
    )
    .min(2, "At least two options are required")
    .max(8),
});

export const problemSchema = z.object({
  roundId: z.string().uuid(),
  title: z.string().trim().min(2, "Title is required").max(200),
  description: z.string().trim().max(8000),
  inputFormat: z.string().trim().max(2000),
  outputFormat: z.string().trim().max(2000),
  constraints: z.string().trim().max(2000),
  examples: z.array(z.object({ input: z.string().max(2000), output: z.string().max(2000) })).max(10),
  difficulty: z.enum(["easy", "medium", "hard"]),
  maxMarks: z.coerce.number().int().min(1).max(1000),
  timeLimitMs: z.coerce.number().int().min(100).max(10000),
  memoryLimitMb: z.coerce.number().int().min(8).max(512),
  allowedLanguages: z.array(z.string().max(40)).min(1, "Select at least one language"),
  orderIndex: z.coerce.number().int().min(1).max(1000),
  enabled: z.boolean(),
});

export const testCaseSchema = z.object({
  problemId: z.string().uuid(),
  input: z.string().max(20000),
  expectedOutput: z.string().max(20000),
  isPublic: z.boolean(),
  orderIndex: z.coerce.number().int().min(1).max(1000),
  weight: z.coerce.number().int().min(1).max(100),
});

export const codeSchema = z.object({
  problemId: z.string().uuid(),
  language: z.string().trim().min(1).max(40),
  code: z.string().min(1, "Write some code first").max(100000),
});
