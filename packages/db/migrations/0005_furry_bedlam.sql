CREATE TYPE "public"."input_kind" AS ENUM('link', 'image', 'text');--> statement-breakpoint
ALTER TABLE "shares" ADD COLUMN "input_kind" "input_kind" DEFAULT 'link' NOT NULL;--> statement-breakpoint
ALTER TABLE "shares" ADD COLUMN "input_text" text;--> statement-breakpoint
ALTER TABLE "shares" ADD COLUMN "media_ref" text;