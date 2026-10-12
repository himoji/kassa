CREATE TYPE "public"."account_type" AS ENUM('PERSONAL', 'BUSINESS');--> statement-breakpoint
CREATE TYPE "public"."purchase_order_status" AS ENUM('DRAFT', 'SIGNED', 'SENT', 'CONFIRMED', 'DELIVERED', 'INVOICED', 'PAYING', 'PAID', 'REJECTED', 'CANCELED');--> statement-breakpoint
CREATE TYPE "public"."shop_order_channel" AS ENUM('DELIVERY', 'TILL');--> statement-breakpoint
CREATE TYPE "public"."stock_movement_kind" AS ENUM('SEED', 'SALE', 'RECEIPT', 'ADJUSTMENT', 'WASTE');--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"unit" text NOT NULL,
	"safety_stock_pct" integer DEFAULT 10 NOT NULL,
	"reorder_cover_days" integer DEFAULT 3 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"currency" text NOT NULL,
	"region" "region" NOT NULL,
	"timezone" text NOT NULL,
	"po_cap_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"supplier_payee_id" uuid NOT NULL,
	"status" "purchase_order_status" DEFAULT 'DRAFT' NOT NULL,
	"created_by" text NOT NULL,
	"currency" text NOT NULL,
	"lines" jsonb NOT NULL,
	"total_minor" bigint NOT NULL,
	"forecast_snapshot" jsonb,
	"reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"core" jsonb,
	"po_hash" text,
	"owner_assertion" jsonb,
	"signed_at" timestamp with time zone,
	"invoice" jsonb,
	"obligation_id" uuid,
	"proposal_id" uuid,
	"timeline" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipes" (
	"merchant_id" uuid NOT NULL,
	"menu_sku" text NOT NULL,
	"inventory_sku" text NOT NULL,
	"qty_per_unit" integer NOT NULL,
	CONSTRAINT "recipes_merchant_id_menu_sku_inventory_sku_pk" PRIMARY KEY("merchant_id","menu_sku","inventory_sku")
);
--> statement-breakpoint
CREATE TABLE "sales_daily" (
	"merchant_id" uuid NOT NULL,
	"day" date NOT NULL,
	"menu_sku" text NOT NULL,
	"qty" integer NOT NULL,
	"revenue_minor" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "sales_daily_merchant_id_day_menu_sku_pk" PRIMARY KEY("merchant_id","day","menu_sku")
);
--> statement-breakpoint
CREATE TABLE "shop_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"merchant_slug" text NOT NULL,
	"merchant_id" uuid,
	"channel" "shop_order_channel" NOT NULL,
	"external_order_id" text,
	"bill_id" text,
	"items" jsonb NOT NULL,
	"total_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" text NOT NULL,
	"timeline" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proposal_id" uuid,
	"payment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"kind" "stock_movement_kind" NOT NULL,
	"qty" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"supplier_payee_id" uuid NOT NULL,
	"supplier_sku" text NOT NULL,
	"inventory_sku" text NOT NULL,
	"pack_size" integer NOT NULL,
	"pack_price_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"min_order_packs" integer DEFAULT 1 NOT NULL,
	"lead_time_days" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "account_type" "account_type" DEFAULT 'PERSONAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_payee_id_payees_id_fk" FOREIGN KEY ("supplier_payee_id") REFERENCES "public"."payees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_daily" ADD CONSTRAINT "sales_daily_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_orders" ADD CONSTRAINT "shop_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_orders" ADD CONSTRAINT "shop_orders_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_items" ADD CONSTRAINT "supplier_items_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_items" ADD CONSTRAINT "supplier_items_supplier_payee_id_payees_id_fk" FOREIGN KEY ("supplier_payee_id") REFERENCES "public"."payees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_items_merchant_sku_uq" ON "inventory_items" USING btree ("merchant_id","sku");--> statement-breakpoint
CREATE UNIQUE INDEX "merchants_slug_uq" ON "merchants" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "merchants_owner_idx" ON "merchants" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_merchant_idx" ON "purchase_orders" USING btree ("merchant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_po_hash_uq" ON "purchase_orders" USING btree ("po_hash");--> statement-breakpoint
CREATE INDEX "shop_orders_user_idx" ON "shop_orders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_orders_slug_external_uq" ON "shop_orders" USING btree ("merchant_slug","external_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_orders_slug_bill_uq" ON "shop_orders" USING btree ("merchant_slug","bill_id");--> statement-breakpoint
CREATE INDEX "shop_orders_proposal_idx" ON "shop_orders" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "stock_movements_merchant_sku_idx" ON "stock_movements" USING btree ("merchant_id","sku","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_items_merchant_supplier_sku_uq" ON "supplier_items" USING btree ("merchant_id","supplier_payee_id","supplier_sku");--> statement-breakpoint
CREATE INDEX "supplier_items_merchant_inventory_idx" ON "supplier_items" USING btree ("merchant_id","inventory_sku");