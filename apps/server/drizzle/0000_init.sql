CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"handle" text NOT NULL,
	"display_name" text NOT NULL,
	"provider" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"accept_from" text DEFAULT 'members' NOT NULL,
	"token_hash" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"connected" boolean DEFAULT false NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"provider_version" text,
	"capabilities" jsonb,
	"max_permission" text,
	"repo" jsonb,
	"last_event" text,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"task_id" uuid,
	"message_id" uuid,
	"kind" text NOT NULL,
	"instruction" text NOT NULL,
	"context" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"permission" text NOT NULL,
	"expected_commit" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"execution_id" text,
	"exit_code" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "dispatches_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"dispatch_id" uuid,
	"from_type" text NOT NULL,
	"from_id" uuid,
	"from_name" text NOT NULL,
	"to_type" text,
	"to_id" uuid,
	"to_name" text,
	"note" text DEFAULT '' NOT NULL,
	"data" jsonb NOT NULL,
	"diff" text,
	"diff_truncated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_uses" integer NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "memory_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"source_name" text NOT NULL,
	"task_id" uuid,
	"message_id" uuid,
	"verified_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"author_type" text NOT NULL,
	"author_user_id" uuid,
	"author_agent_id" uuid,
	"body" text NOT NULL,
	"reply_to_id" uuid,
	"mentions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dispatch_id" uuid,
	"task_id" uuid,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"client_nonce" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_seq_unique" UNIQUE("seq")
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_members_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"owner_id" uuid NOT NULL,
	"task_counter" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"dispatch_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "task_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"actor_name" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"created_by" uuid NOT NULL,
	"assignee_user_id" uuid,
	"assignee_agent_id" uuid,
	"branch" text,
	"commit" text,
	"last_result" text,
	"source_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_dispatch_id_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "public"."dispatches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_dispatch_id_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "public"."dispatches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_project_handle_uq" ON "agents" USING btree ("project_id","handle");--> statement-breakpoint
CREATE INDEX "dispatches_agent_status_idx" ON "dispatches" USING btree ("agent_id","status");--> statement-breakpoint
CREATE INDEX "dispatches_task_idx" ON "dispatches" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatches_one_running_per_agent_uq" ON "dispatches" USING btree ("agent_id") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "handoffs_task_idx" ON "handoffs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "memory_project_idx" ON "memory_entries" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "messages_project_seq_idx" ON "messages" USING btree ("project_id","seq");--> statement-breakpoint
CREATE INDEX "messages_task_idx" ON "messages" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_nonce_uq" ON "messages" USING btree ("project_id","author_user_id","client_nonce");--> statement-breakpoint
CREATE INDEX "members_user_idx" ON "project_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_events_dispatch_seq_uq" ON "run_events" USING btree ("dispatch_id","seq");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "task_events_task_idx" ON "task_events" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_project_number_uq" ON "tasks" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "tasks_project_idx" ON "tasks" USING btree ("project_id");