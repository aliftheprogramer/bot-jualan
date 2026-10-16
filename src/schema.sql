CREATE TABLE products (
  code text PRIMARY KEY,
  name text NOT NULL,
  category text NOT NULL,
  price integer NOT NULL CHECK (price >= 0),
  kind text NOT NULL CHECK (kind IN ('OWN_STOCK', 'DIGIFLAZZ')),
  active boolean NOT NULL DEFAULT true,
  sku text UNIQUE,
  max_price integer CHECK (max_price > 0),
  supplier_cost integer,
  supplier_available boolean NOT NULL DEFAULT true,
  target_type text NOT NULL DEFAULT 'NONE' CHECK (target_type IN ('NONE', 'PHONE', 'ID')),
  CHECK (kind != 'DIGIFLAZZ' OR (sku IS NOT NULL AND max_price IS NOT NULL AND target_type != 'NONE'))
);

CREATE TABLE orders (
  id uuid PRIMARY KEY,
  customer text NOT NULL,
  request_key text NOT NULL UNIQUE,
  product_code text NOT NULL REFERENCES products(code),
  product_name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('OWN_STOCK', 'DIGIFLAZZ')),
  amount integer NOT NULL CHECK (amount > 0),
  target text NOT NULL DEFAULT '',
  sku text,
  max_price integer,
  payment_id text UNIQUE,
  payment_status text NOT NULL DEFAULT 'CREATING' CHECK (payment_status IN ('CREATING', 'PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELED', 'REVIEW')),
  fulfillment_status text NOT NULL DEFAULT 'NOT_STARTED' CHECK (fulfillment_status IN ('NOT_STARTED', 'QUEUED', 'PROCESSING', 'PENDING_SUPPLIER', 'READY', 'DELIVERED', 'FAILED', 'REVIEW')),
  cancel_requested boolean NOT NULL DEFAULT false,
  checkout_started boolean NOT NULL DEFAULT false,
  result text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_customer ON orders(customer, created_at DESC);

CREATE TABLE stock_items (
  id uuid PRIMARY KEY,
  product_code text NOT NULL REFERENCES products(code),
  payload text NOT NULL,
  payload_hash text NOT NULL,
  state text NOT NULL DEFAULT 'AVAILABLE' CHECK (state IN ('AVAILABLE', 'RESERVED', 'SOLD')),
  order_id uuid UNIQUE REFERENCES orders(id),
  UNIQUE(product_code, payload_hash),
  CHECK ((state = 'AVAILABLE' AND order_id IS NULL) OR (state != 'AVAILABLE' AND order_id IS NOT NULL))
);
CREATE INDEX available_stock ON stock_items(product_code, state);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  job_key text NOT NULL UNIQUE,
  type text NOT NULL CHECK (type IN ('CHECKOUT', 'RECONCILE', 'FULFILL', 'NOTIFY', 'PAYMENT_EVENT', 'SUPPLIER_EVENT', 'COMMAND')),
  order_id uuid REFERENCES orders(id),
  payload text NOT NULL,
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED', 'RUNNING', 'DONE', 'DEAD')),
  attempts integer NOT NULL DEFAULT 0,
  run_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_token uuid,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ready_jobs ON jobs(state, run_at);

CREATE TABLE webhook_events (
  event_key text PRIMARY KEY,
  provider text NOT NULL,
  payload_hash text NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id),
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE incoming_messages (
  message_key text PRIMARY KEY,
  customer text NOT NULL,
  response text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE menu_sessions (
  customer text PRIMARY KEY,
  categories jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,
  resource text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
