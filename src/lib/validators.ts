import { z } from "zod";

export const registerSchema = z.object({
  name: z.string().min(2, "Please enter your full name").max(120),
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  plan: z.enum(["consumer", "business"]).default("consumer"),
  phone: z.string().max(20).optional().nullable(),
});

export const loginSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(1, "Enter your password"),
});

export const contactSchema = z.object({
  name: z.string().min(1, "Name is required").max(160),
  phone: z.string().min(5, "Phone number is required").max(20),
  email: z.string().email().optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
});

export const smsSchema = z.object({
  conversation_id: z.string().optional(),
  to_number: z.string().min(5, "Destination number is required"),
  from_did_id: z.string().min(1, "Source phone number is required"),
  body: z.string().min(1, "Message body is required").max(1600),
});

export const faxSchema = z.object({
  to_number: z.string().min(5, "Destination fax number is required"),
  from_did_id: z.string().min(1, "Source fax number is required"),
  subject: z.string().max(200).optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
});
