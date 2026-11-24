-- Full schema. Installed once by migrate.js on an empty database; later changes go in db/NNN_name.sql.

CREATE FUNCTION public.normalize_description(txt text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$ SELECT upper(btrim(regexp_replace(txt, '[[:space:]]+', ' ', 'g'))) $$;

COMMENT ON FUNCTION public.normalize_description(txt text) IS 'Uppercase, trimmed, inner whitespace collapsed. The one definition of "same description".';

CREATE FUNCTION public.normalize_supplier(txt text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$ SELECT lower(regexp_replace(btrim(txt), '\s+', ' ', 'g')) $$;

CREATE TABLE public.user_audit_log (
    id integer NOT NULL,
    user_id integer NOT NULL,
    actor_id integer,
    action character varying(20) NOT NULL,
    detail text,
    date timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT audit_action_check CHECK (((action)::text = ANY ((ARRAY['create'::character varying, 'pin'::character varying, 'password'::character varying, 'own_password'::character varying, 'role'::character varying, 'deactivate'::character varying, 'reactivate'::character varying, 'unlock'::character varying, 'attempts'::character varying, 'backup'::character varying])::text[])))
);

COMMENT ON TABLE public.user_audit_log IS 'Who changed whose credentials and when. Never stores the password or its hash.';

COMMENT ON COLUMN public.user_audit_log.actor_id IS 'NULL when the change came from scripts/users.js, without a session.';

CREATE SEQUENCE public.user_audit_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.user_audit_log_id_seq OWNED BY public.user_audit_log.id;

CREATE TABLE public.categories (
    id integer NOT NULL,
    name character varying(50) NOT NULL,
    parent_category_id integer
);

CREATE SEQUENCE public.categories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.categories_id_seq OWNED BY public.categories.id;

CREATE TABLE public.purchases (
    id integer NOT NULL,
    book_id integer NOT NULL,
    source_record_id integer,
    sheet text NOT NULL,
    sheet_order integer NOT NULL,
    cell text NOT NULL,
    row_num integer NOT NULL,
    type character varying(12) NOT NULL,
    date date,
    date_status text NOT NULL,
    description text NOT NULL,
    description_norm text GENERATED ALWAYS AS (public.normalize_description(description)) STORED,
    quantity numeric(12,3),
    unit_price numeric(14,3),
    amount numeric GENERATED ALWAYS AS ((quantity * unit_price)) STORED,
    supplier_text text,
    supplier_id integer,
    folio text,
    requester text,
    note text,
    movement_id integer,
    import_id integer,
    CONSTRAINT purchases_type_check CHECK (((type)::text = ANY ((ARRAY['purchase'::character varying, 'no_amount'::character varying, 'note'::character varying])::text[])))
);

COMMENT ON TABLE public.purchases IS 'Purchase book lines as written. A purchase line is not a stock movement.';

COMMENT ON COLUMN public.purchases.date IS 'NULL when the book does not give the day (see date_status). We never make up a day 1.';

COMMENT ON COLUMN public.purchases.amount IS 'Not proof of payment, and the books carry no currency.';

COMMENT ON COLUMN public.purchases.supplier_id IS 'Set only on an exact case-insensitive name match. Look-alikes are never merged.';

COMMENT ON COLUMN public.purchases.movement_id IS 'Linked only when the pairing is unique both ways; if ambiguous it stays NULL.';

COMMENT ON COLUMN public.purchases.import_id IS 'The book import that brought this line. NULL means it cannot be undone.';

CREATE SEQUENCE public.purchases_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.purchases_id_seq OWNED BY public.purchases.id;

CREATE TABLE public.supplier_tags (
    id integer NOT NULL,
    name text NOT NULL,
    name_norm text GENERATED ALWAYS AS (lower(name)) STORED,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT supplier_tags_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 30)))
);

COMMENT ON TABLE public.supplier_tags IS 'Preset tags offered even when no supplier uses them. Tags in use live in suppliers.tags.';

ALTER TABLE public.supplier_tags ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.supplier_tags_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.invoice_files (
    id integer NOT NULL,
    invoice_id integer NOT NULL,
    name text NOT NULL,
    mime text NOT NULL,
    bytes integer NOT NULL,
    sha256 text NOT NULL,
    content bytea NOT NULL,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    uploaded_by integer,
    CONSTRAINT invoice_files_bytes_actual CHECK ((bytes = octet_length(content))),
    CONSTRAINT invoice_files_mime_valid CHECK ((mime = ANY (ARRAY['application/pdf'::text, 'image/jpeg'::text, 'image/png'::text, 'image/webp'::text, 'application/xml'::text]))),
    CONSTRAINT invoice_files_size CHECK (((bytes > 0) AND (bytes <= 15728640)))
);

ALTER TABLE public.invoice_files ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.invoice_files_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.invoice_lines (
    id integer NOT NULL,
    invoice_id integer NOT NULL,
    sort_order integer NOT NULL,
    description text NOT NULL,
    quantity numeric(18,6),
    unit text,
    unit_key text,
    prod_serv_key text,
    identification_no text,
    unit_value numeric(18,6),
    amount numeric(14,2),
    product_id integer,
    movement_id integer,
    reconciliation text DEFAULT 'pending'::text NOT NULL,
    reconciled_at timestamp with time zone,
    reconciled_by integer,
    CONSTRAINT invoice_lines_sort_order_minimum CHECK ((sort_order >= 1)),
    CONSTRAINT lines_reconciliation_valid CHECK ((reconciliation = ANY (ARRAY['pending'::text, 'stock_in'::text, 'no_stock_in'::text]))),
    CONSTRAINT lines_stock_in_complete CHECK (((reconciliation <> 'stock_in'::text) OR ((product_id IS NOT NULL) AND (movement_id IS NOT NULL))))
);

COMMENT ON TABLE public.invoice_lines IS 'product_id is optional; amount is the printed one, never recalculated.';

COMMENT ON COLUMN public.invoice_lines.movement_id IS 'The stock-in this line created. To undo it, record an adjustment.';

COMMENT ON COLUMN public.invoice_lines.reconciliation IS 'stock_in created a movement; no_stock_in was reviewed and does not go into stock.';

ALTER TABLE public.invoice_lines ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.invoice_lines_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.invoices (
    id integer NOT NULL,
    source text NOT NULL,
    uuid text,
    uuid_source text,
    supplier_id integer,
    issuer_rfc text,
    issuer_name text,
    receiver_rfc text,
    series text,
    folio text,
    voucher_type text,
    invoice_date date,
    date_confirmed boolean DEFAULT false NOT NULL,
    stamped_at timestamp with time zone,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    captured_by integer NOT NULL,
    subtotal numeric(14,2),
    vat numeric(14,2),
    total numeric(14,2) NOT NULL,
    currency text DEFAULT 'MXN'::text NOT NULL,
    payment_method text,
    payment_form text,
    cfdi_use text,
    purchase_type text DEFAULT 'unclassified'::text NOT NULL,
    due_on date,
    paid_at date,
    supplier_ids jsonb DEFAULT '{}'::jsonb NOT NULL,
    pages integer DEFAULT 1 NOT NULL,
    sat_status text,
    sat_status_checked_at timestamp with time zone,
    note text,
    spend_category text,
    project text,
    classification jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT invoices_classification_is_object CHECK ((jsonb_typeof(classification) = 'object'::text)),
    CONSTRAINT invoices_sat_status_valid CHECK (((sat_status IS NULL) OR (sat_status = ANY (ARRAY['Vigente'::text, 'Cancelado'::text, 'No Encontrado'::text])))),
    CONSTRAINT invoices_date_confirmed CHECK (((NOT date_confirmed) OR (invoice_date IS NOT NULL))),
    CONSTRAINT invoices_source_valid CHECK ((source = ANY (ARRAY['xml'::text, 'qr'::text, 'photo'::text, 'manual'::text]))),
    CONSTRAINT invoices_ids_is_object CHECK ((jsonb_typeof(supplier_ids) = 'object'::text)),
    CONSTRAINT invoices_payment_method_valid CHECK (((payment_method IS NULL) OR (payment_method = ANY (ARRAY['PUE'::text, 'PPD'::text])))),
    CONSTRAINT invoices_pages_minimum CHECK ((pages >= 1)),
    CONSTRAINT invoices_purchase_type_valid CHECK ((purchase_type = ANY (ARRAY['stock'::text, 'direct_to_job'::text, 'unclassified'::text]))),
    CONSTRAINT invoices_total_non_negative CHECK ((total >= (0)::numeric)),
    CONSTRAINT invoices_uuid_with_source CHECK (((uuid IS NULL) = (uuid_source IS NULL))),
    CONSTRAINT invoices_uuid_format CHECK (((uuid IS NULL) OR (uuid ~ '^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$'::text))),
    CONSTRAINT invoices_uuid_source_valid CHECK (((uuid_source IS NULL) OR (uuid_source = ANY (ARRAY['xml'::text, 'qr'::text, 'manual'::text])))),
    CONSTRAINT invoices_due_after CHECK (((due_on IS NULL) OR (invoice_date IS NULL) OR (due_on >= invoice_date)))
);

COMMENT ON TABLE public.invoices IS 'Supplier invoice header (accounts payable). Amounts are as printed, never recalculated.';

COMMENT ON COLUMN public.invoices.uuid IS 'Only from XML, QR or typed by a person (uuid_source), never from the AI reader: it makes them up.';

COMMENT ON COLUMN public.invoices.date_confirmed IS 'false when the date came from the AI reader or nobody checked it yet.';

COMMENT ON COLUMN public.invoices.purchase_type IS 'direct_to_job never touches the stock; unclassified means nobody decided yet, so we do not guess.';

COMMENT ON COLUMN public.invoices.supplier_ids IS 'The issuer''s own reference numbers (delivery note, PO, work order) as a JSON object.';

COMMENT ON COLUMN public.invoices.spend_category IS 'What was bought, as proposed by classify.js. NULL when it could not tell.';

COMMENT ON COLUMN public.invoices.classification IS 'Where each tag value came from. Manual choices are never overwritten.';

CREATE TABLE public.deleted_invoices (
    id integer NOT NULL,
    invoice_id integer NOT NULL,
    uuid text,
    issuer_name text,
    issuer_rfc text,
    series text,
    folio text,
    invoice_date date,
    total numeric(14,2),
    lines integer DEFAULT 0 NOT NULL,
    files integer DEFAULT 0 NOT NULL,
    deleted_by integer,
    deleted_at timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.deleted_invoices IS 'Snapshot of each deleted invoice and who deleted it. Files are not kept.';

ALTER TABLE public.deleted_invoices ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.deleted_invoices_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE public.invoices ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.invoices_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.book_imports (
    id integer NOT NULL,
    book_id integer,
    file text NOT NULL,
    sha256 character(64) NOT NULL,
    user_id integer,
    done_at timestamp with time zone DEFAULT now() NOT NULL,
    new_count integer NOT NULL,
    existing_count integer NOT NULL,
    description_differs integer NOT NULL,
    links_created integer NOT NULL,
    undone_at timestamp with time zone,
    undone_by integer,
    CONSTRAINT book_imports_description_differs_check CHECK ((description_differs >= 0)),
    CONSTRAINT book_imports_links_created_check CHECK ((links_created >= 0)),
    CONSTRAINT book_imports_new_count_check CHECK ((new_count >= 0)),
    CONSTRAINT book_imports_existing_count_check CHECK ((existing_count >= 0))
);

COMMENT ON TABLE public.book_imports IS 'Who imported which purchase book and the result. An import that changed nothing leaves no row.';

COMMENT ON COLUMN public.book_imports.sha256 IS 'Hash of the exact .xlsx that was uploaded.';

COMMENT ON COLUMN public.book_imports.description_differs IS 'Rows whose description differs from the stored one (a fixed typo). They are neither inserted nor rewritten.';

COMMENT ON COLUMN public.book_imports.undone_at IS 'When an admin undid the import, deleting its lines and links.';

ALTER TABLE public.book_imports ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.book_imports_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.purchase_books (
    id integer NOT NULL,
    file text NOT NULL,
    period character(7) NOT NULL,
    source_origin_id integer,
    loaded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT purchase_books_period_check CHECK ((period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text))
);

COMMENT ON TABLE public.purchase_books IS 'One row per Excel purchase book. period is the book''s month, not the month of its dates.';

CREATE SEQUENCE public.purchase_books_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.purchase_books_id_seq OWNED BY public.purchase_books.id;

CREATE TABLE public.movements (
    id integer NOT NULL,
    product_id integer NOT NULL,
    type character varying(20) NOT NULL,
    quantity numeric(12,3) NOT NULL,
    user_id integer,
    supplier_id integer,
    unit_price numeric(12,2),
    folio character varying(40),
    note text,
    date timestamp with time zone DEFAULT now() NOT NULL,
    origin character varying(20) DEFAULT 'operational'::character varying NOT NULL,
    source text,
    over_negative boolean DEFAULT false NOT NULL,
    responsible_id integer,
    CONSTRAINT movements_quantity_check CHECK ((quantity > (0)::numeric)),
    CONSTRAINT movements_origin_check CHECK (((origin)::text = ANY (ARRAY[('operational'::character varying)::text, ('historical'::character varying)::text]))),
    CONSTRAINT movements_type_check CHECK (((type)::text = ANY (ARRAY[('in'::character varying)::text, ('out'::character varying)::text, ('adjustment'::character varying)::text, ('loan'::character varying)::text, ('return'::character varying)::text]))),
    CONSTRAINT operational_with_user CHECK ((((origin)::text <> 'operational'::text) OR (user_id IS NOT NULL)))
);

COMMENT ON COLUMN public.movements.over_negative IS 'true when the operator explicitly confirmed it despite leaving a negative balance.';

COMMENT ON COLUMN public.movements.responsible_id IS 'Who took the item when it was not the person using the app. NULL means user_id.';

CREATE SEQUENCE public.movements_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.movements_id_seq OWNED BY public.movements.id;

CREATE TABLE public.product_aliases (
    id integer NOT NULL,
    product_id integer NOT NULL,
    alias text NOT NULL,
    origin character varying(20) DEFAULT 'purchases'::character varying NOT NULL,
    alias_norm text GENERATED ALWAYS AS (public.normalize_description(alias)) STORED,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    import_id integer
);

COMMENT ON COLUMN public.product_aliases.alias_norm IS 'Unique: a purchase description links to one product only.';

COMMENT ON COLUMN public.product_aliases.import_id IS 'The book import in which a person confirmed this link.';

CREATE SEQUENCE public.product_aliases_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.product_aliases_id_seq OWNED BY public.product_aliases.id;

CREATE TABLE public.product_codes (
    id integer NOT NULL,
    product_id integer NOT NULL,
    code text NOT NULL,
    format character varying(24),
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    type text DEFAULT 'barcode'::text NOT NULL,
    description text,
    pieces numeric(12,3),
    CONSTRAINT product_codes_code_not_empty CHECK ((btrim(code) <> ''::text)),
    CONSTRAINT product_codes_pieces_positive CHECK (((pieces IS NULL) OR (pieces > (0)::numeric))),
    CONSTRAINT product_codes_type_valid CHECK ((type = ANY (ARRAY['barcode'::text, 'supplier'::text])))
);

COMMENT ON TABLE public.product_codes IS 'Codes printed by the manufacturer or used by a supplier. One code identifies one product.';

COMMENT ON COLUMN public.product_codes.type IS 'barcode is scanned; supplier is the supplier part number (typed, or NoIdentificacion on the invoice).';

COMMENT ON COLUMN public.product_codes.description IS 'What the supplier or the packaging calls it. Reference only, not searched.';

COMMENT ON COLUMN public.product_codes.pieces IS 'How many pieces this code stands for (1 each, 25 a box). NULL means unknown; never assume 1.';

CREATE SEQUENCE public.product_codes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.product_codes_id_seq OWNED BY public.product_codes.id;

CREATE TABLE public.products (
    id integer NOT NULL,
    code character varying(50) NOT NULL,
    name character varying(200) NOT NULL,
    quantity numeric(12,3) DEFAULT 0 NOT NULL,
    location character varying(100),
    created_at timestamp without time zone DEFAULT now(),
    price numeric(10,2),
    unit character varying(20) DEFAULT 'piece'::character varying NOT NULL,
    category character varying(50),
    category_id integer,
    control_type character varying(20) DEFAULT 'stock'::character varying NOT NULL,
    minimum numeric(12,3),
    restock_control character varying(12) DEFAULT 'calculated'::character varying NOT NULL,
    count_pending boolean DEFAULT false NOT NULL,
    brand character varying(60),
    group_name character varying(40),
    target_level numeric(12,3),
    CONSTRAINT minimum_non_negative CHECK (((minimum IS NULL) OR (minimum >= (0)::numeric))),
    CONSTRAINT price_non_negative CHECK ((price >= (0)::numeric)),
    CONSTRAINT products_restock_control_check CHECK (((restock_control)::text = ANY (ARRAY[('calculated'::character varying)::text, ('manual'::character varying)::text]))),
    CONSTRAINT products_target_level_non_negative CHECK (((target_level IS NULL) OR (target_level >= (0)::numeric))),
    CONSTRAINT products_control_type_check CHECK (((control_type)::text = ANY (ARRAY[('unit'::character varying)::text, ('stock'::character varying)::text, ('no_balance'::character varying)::text])))
);

COMMENT ON COLUMN public.products.minimum IS 'NULL means not set yet, which is not the same as zero.';

COMMENT ON COLUMN public.products.restock_control IS 'manual means stock is not observable (gas cylinders), so a person files a restock_request.';

COMMENT ON COLUMN public.products.count_pending IS 'true when quantity did not come from a physical count. Show "uncounted", never a believable zero.';

COMMENT ON COLUMN public.products.group_name IS 'Shared by variants of the same item (other brands or sizes). The UI shows one row per group.';

COMMENT ON COLUMN public.products.target_level IS 'Order up to this when stock drops below minimum. NULL means not set; we never guess.';

CREATE TABLE public.product_changes (
    id integer NOT NULL,
    product_id integer NOT NULL,
    user_id integer,
    field text NOT NULL,
    before text,
    after text,
    done_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_changes_field_check CHECK ((field = ANY (ARRAY['code'::text, 'name'::text, 'category'::text, 'location'::text, 'brand'::text, 'group_name'::text, 'price'::text])))
);

COMMENT ON COLUMN public.product_changes.before IS 'NULL means the field was empty. Category is stored by name, price with two decimals.';

ALTER TABLE public.product_changes ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.product_changes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE SEQUENCE public.products_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.products_id_seq OWNED BY public.products.id;

CREATE TABLE public.supplier_aliases (
    id integer NOT NULL,
    supplier_id integer NOT NULL,
    alias text NOT NULL,
    alias_norm text GENERATED ALWAYS AS (public.normalize_supplier(alias)) STORED,
    origin text NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT supplier_aliases_alias_check CHECK (((length(btrim(alias)) >= 1) AND (length(btrim(alias)) <= 120))),
    CONSTRAINT supplier_aliases_origin_check CHECK ((origin = ANY (ARRAY['manual'::text, 'equivalence'::text, 'rename'::text, 'merge'::text])))
);

COMMENT ON TABLE public.supplier_aliases IS 'Other names for the same supplier, checked when a name does not match suppliers.name.';

COMMENT ON COLUMN public.supplier_aliases.origin IS 'equivalence: picked "same supplier" for a book name; rename: the old name; merge: the name of a merged supplier.';

COMMENT ON COLUMN public.supplier_aliases.created_by IS 'From the session, never from the request body.';

ALTER TABLE public.supplier_aliases ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.supplier_aliases_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.supplier_contacts (
    id integer NOT NULL,
    supplier_id integer NOT NULL,
    name text,
    email text,
    address text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    phones text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT supplier_contacts_any CHECK (((name IS NOT NULL) OR (cardinality(phones) > 0) OR (email IS NOT NULL) OR (address IS NOT NULL))),
    CONSTRAINT supplier_contacts_email_check CHECK (((email IS NULL) OR ((length(email) >= 3) AND (length(email) <= 120)))),
    CONSTRAINT supplier_contacts_address_check CHECK (((address IS NULL) OR ((length(address) >= 1) AND (length(address) <= 300)))),
    CONSTRAINT supplier_contacts_name_check CHECK (((name IS NULL) OR ((length(name) >= 1) AND (length(name) <= 120)))),
    CONSTRAINT supplier_contacts_phones_max CHECK (((cardinality(phones) <= 5) AND (array_position(phones, NULL::text) IS NULL)))
);

COMMENT ON TABLE public.supplier_contacts IS 'Every field is optional, but not all of them empty.';

COMMENT ON COLUMN public.supplier_contacts.phones IS 'Up to 5 numbers of up to 40 characters.';

ALTER TABLE public.supplier_contacts ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.supplier_contacts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.suppliers (
    id integer NOT NULL,
    name character varying(120) NOT NULL,
    rfc text,
    note text,
    archived_at timestamp with time zone,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT suppliers_tags_max CHECK (((cardinality(tags) <= 8) AND (array_position(tags, NULL::text) IS NULL))),
    CONSTRAINT suppliers_note_length CHECK (((note IS NULL) OR (length(note) <= 1000))),
    CONSTRAINT suppliers_rfc_format CHECK (((rfc IS NULL) OR (rfc ~ '^[A-ZÑ&0-9]{12,13}$'::text)))
);

COMMENT ON COLUMN public.suppliers.rfc IS 'Uppercase. XML invoices carry the issuer RFC, so they link without relying on the name.';

COMMENT ON COLUMN public.suppliers.archived_at IS 'Archived suppliers are hidden from lists and pickers but keep their history.';

COMMENT ON COLUMN public.suppliers.tags IS 'Up to 8, 30 characters each. The server cleans them and unifies the spelling.';

CREATE SEQUENCE public.suppliers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.suppliers_id_seq OWNED BY public.suppliers.id;

CREATE TABLE public.push_keys (
    id boolean DEFAULT true NOT NULL,
    public_key text NOT NULL,
    private_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT push_keys_id_check CHECK (id)
);

COMMENT ON TABLE public.push_keys IS 'Server VAPID keys, single row. The private key signs notifications and is never exposed.';

CREATE TABLE public.push_subscriptions (
    id integer NOT NULL,
    user_id integer NOT NULL,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.push_subscriptions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.push_subscriptions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.backups (
    id integer NOT NULL,
    done_at timestamp with time zone DEFAULT now() NOT NULL,
    file text NOT NULL,
    bytes bigint NOT NULL,
    CONSTRAINT backups_bytes_check CHECK ((bytes > 0))
);

COMMENT ON TABLE public.backups IS 'One row per finished backup. Diagnostics warn when there is no recent one.';

ALTER TABLE public.backups ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.backups_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.schema_migrations (
    version integer NOT NULL,
    file text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL,
    origin text DEFAULT 'runner'::text NOT NULL,
    CONSTRAINT schema_migrations_origin_check CHECK ((origin = ANY (ARRAY['runner'::text, 'manual'::text])))
);

CREATE TABLE public.sessions (
    id integer NOT NULL,
    user_id integer NOT NULL,
    token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    closed_at timestamp with time zone,
    CONSTRAINT expires_after_creation CHECK ((expires_at > created_at))
);

COMMENT ON TABLE public.sessions IS 'A table instead of signed tokens so a session can be revoked (lost phone).';

CREATE SEQUENCE public.sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.sessions_id_seq OWNED BY public.sessions.id;

CREATE TABLE public.request_items (
    id integer NOT NULL,
    request_id integer NOT NULL,
    product_id integer NOT NULL,
    quantity numeric(12,3) NOT NULL,
    CONSTRAINT request_items_quantity_check CHECK ((quantity > (0)::numeric))
);

ALTER TABLE public.request_items ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.request_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.material_requests (
    id integer NOT NULL,
    requester_id integer NOT NULL,
    note text,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    handled_by integer,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT material_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'ready'::text, 'delivered'::text, 'cancelled'::text])))
);

COMMENT ON TABLE public.material_requests IS 'Shop floor asking the storeroom for material. Does not move stock: the hand-out is a movement.';

COMMENT ON COLUMN public.material_requests.handled_by IS 'NULL while pending, or when the requester cancelled it.';

ALTER TABLE public.material_requests ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.material_requests_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.restock_requests (
    id integer NOT NULL,
    product_id integer NOT NULL,
    requested_by integer NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    note text,
    handled_at timestamp with time zone,
    movement_id integer,
    CONSTRAINT handled_consistent CHECK ((((handled_at IS NULL) AND (movement_id IS NULL)) OR (handled_at IS NOT NULL)))
);

COMMENT ON TABLE public.restock_requests IS 'Refill requests raised by a person for products with restock_control = manual. Closed by a stock-in.';

CREATE SEQUENCE public.restock_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.restock_requests_id_seq OWNED BY public.restock_requests.id;

CREATE TABLE public.users (
    id integer NOT NULL,
    name character varying(80) NOT NULL,
    role character varying(20) DEFAULT 'operator'::character varying NOT NULL,
    active boolean DEFAULT true NOT NULL,
    password_hash text,
    failed_attempts integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    username text NOT NULL,
    must_change_password boolean DEFAULT false NOT NULL,
    password_changed_at timestamp with time zone,
    temp_password_until timestamp with time zone,
    CONSTRAINT password_hash_format CHECK (((password_hash IS NULL) OR (password_hash ~~ 'scrypt$%'::text))),
    CONSTRAINT users_role_check CHECK (((role)::text = ANY ((ARRAY['operator'::character varying, 'storekeeper'::character varying, 'admin'::character varying, 'technician'::character varying])::text[]))),
    CONSTRAINT users_username_format CHECK ((username ~ '^[a-z0-9][a-z0-9._-]{1,29}$'::text))
);

COMMENT ON COLUMN public.users.password_hash IS 'scrypt$N$r$p$salt_b64$hash_b64 with a per-user salt. NULL means the user cannot sign in yet.';

COMMENT ON COLUMN public.users.locked_until IS 'While in the future the user cannot sign in, even with the right password.';

COMMENT ON COLUMN public.users.username IS 'What people sign in with; name is only for display.';

COMMENT ON COLUMN public.users.must_change_password IS 'true when an admin set a temporary password. The server allows nothing but changing it.';

COMMENT ON COLUMN public.users.password_changed_at IS 'When the user last changed their own password.';

COMMENT ON COLUMN public.users.temp_password_until IS 'Expiry of an admin-assigned temporary password. NULL means it is not temporary.';

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;

ALTER TABLE ONLY public.user_audit_log ALTER COLUMN id SET DEFAULT nextval('public.user_audit_log_id_seq'::regclass);

ALTER TABLE ONLY public.categories ALTER COLUMN id SET DEFAULT nextval('public.categories_id_seq'::regclass);

ALTER TABLE ONLY public.purchases ALTER COLUMN id SET DEFAULT nextval('public.purchases_id_seq'::regclass);

ALTER TABLE ONLY public.purchase_books ALTER COLUMN id SET DEFAULT nextval('public.purchase_books_id_seq'::regclass);

ALTER TABLE ONLY public.movements ALTER COLUMN id SET DEFAULT nextval('public.movements_id_seq'::regclass);

ALTER TABLE ONLY public.product_aliases ALTER COLUMN id SET DEFAULT nextval('public.product_aliases_id_seq'::regclass);

ALTER TABLE ONLY public.product_codes ALTER COLUMN id SET DEFAULT nextval('public.product_codes_id_seq'::regclass);

ALTER TABLE ONLY public.products ALTER COLUMN id SET DEFAULT nextval('public.products_id_seq'::regclass);

ALTER TABLE ONLY public.suppliers ALTER COLUMN id SET DEFAULT nextval('public.suppliers_id_seq'::regclass);

ALTER TABLE ONLY public.sessions ALTER COLUMN id SET DEFAULT nextval('public.sessions_id_seq'::regclass);

ALTER TABLE ONLY public.restock_requests ALTER COLUMN id SET DEFAULT nextval('public.restock_requests_id_seq'::regclass);

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);

ALTER TABLE ONLY public.user_audit_log
    ADD CONSTRAINT user_audit_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_name_key UNIQUE (name);

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.purchases
    ADD CONSTRAINT purchases_movement_id_key UNIQUE (movement_id);

ALTER TABLE ONLY public.purchases
    ADD CONSTRAINT purchases_source_record_id_key UNIQUE (source_record_id);

ALTER TABLE ONLY public.purchases
    ADD CONSTRAINT purchases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.supplier_tags
    ADD CONSTRAINT supplier_tags_name_unique UNIQUE (name_norm);

ALTER TABLE ONLY public.supplier_tags
    ADD CONSTRAINT supplier_tags_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.invoice_files
    ADD CONSTRAINT invoice_files_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.invoice_files
    ADD CONSTRAINT invoice_files_unique UNIQUE (invoice_id, sha256);

ALTER TABLE ONLY public.invoice_lines
    ADD CONSTRAINT invoice_lines_sort_order_unique UNIQUE (invoice_id, sort_order);

ALTER TABLE ONLY public.invoice_lines
    ADD CONSTRAINT invoice_lines_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.deleted_invoices
    ADD CONSTRAINT deleted_invoices_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.book_imports
    ADD CONSTRAINT book_imports_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.purchase_books
    ADD CONSTRAINT purchase_books_file_key UNIQUE (file);

ALTER TABLE ONLY public.purchase_books
    ADD CONSTRAINT purchase_books_source_origin_id_key UNIQUE (source_origin_id);

ALTER TABLE ONLY public.purchase_books
    ADD CONSTRAINT purchase_books_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.invoice_lines
    ADD CONSTRAINT lines_movement_unique UNIQUE (movement_id);

ALTER TABLE ONLY public.movements
    ADD CONSTRAINT movements_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.product_aliases
    ADD CONSTRAINT product_aliases_alias_key UNIQUE (alias);

ALTER TABLE ONLY public.product_aliases
    ADD CONSTRAINT product_aliases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.product_codes
    ADD CONSTRAINT product_codes_code_key UNIQUE (code);

ALTER TABLE ONLY public.product_codes
    ADD CONSTRAINT product_codes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.product_changes
    ADD CONSTRAINT product_changes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_code_key UNIQUE (code);

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.supplier_aliases
    ADD CONSTRAINT supplier_aliases_norm_unique UNIQUE (alias_norm);

ALTER TABLE ONLY public.supplier_aliases
    ADD CONSTRAINT supplier_aliases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.supplier_contacts
    ADD CONSTRAINT supplier_contacts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT suppliers_name_key UNIQUE (name);

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT suppliers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.push_keys
    ADD CONSTRAINT push_keys_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint);

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.backups
    ADD CONSTRAINT backups_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY public.request_items
    ADD CONSTRAINT request_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.material_requests
    ADD CONSTRAINT material_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.restock_requests
    ADD CONSTRAINT restock_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

CREATE INDEX purchases_import_idx ON public.purchases USING btree (import_id) WHERE (import_id IS NOT NULL);

CREATE INDEX invoice_files_invoice_idx ON public.invoice_files USING btree (invoice_id);

CREATE INDEX invoice_lines_product_idx ON public.invoice_lines USING btree (product_id) WHERE (product_id IS NOT NULL);

CREATE INDEX deleted_invoices_at_idx ON public.deleted_invoices USING btree (deleted_at DESC);

CREATE INDEX invoices_date_idx ON public.invoices USING btree (invoice_date DESC NULLS LAST, id DESC);

CREATE UNIQUE INDEX invoices_folio_issuer_unique ON public.invoices USING btree (issuer_rfc, COALESCE(series, ''::text), folio) WHERE ((issuer_rfc IS NOT NULL) AND (folio IS NOT NULL));

CREATE INDEX invoices_unpaid_idx ON public.invoices USING btree (due_on) WHERE (paid_at IS NULL);

CREATE INDEX invoices_supplier_idx ON public.invoices USING btree (supplier_id);

CREATE INDEX invoices_project_idx ON public.invoices USING btree (project) WHERE (project IS NOT NULL);

CREATE INDEX invoices_spend_category_idx ON public.invoices USING btree (spend_category) WHERE (spend_category IS NOT NULL);

CREATE UNIQUE INDEX invoices_uuid_unique ON public.invoices USING btree (uuid) WHERE (uuid IS NOT NULL);

CREATE INDEX idx_alias_product ON public.product_aliases USING btree (product_id);

CREATE INDEX idx_audit_actor ON public.user_audit_log USING btree (actor_id, date DESC) WHERE (actor_id IS NOT NULL);

CREATE INDEX idx_audit_user ON public.user_audit_log USING btree (user_id, date DESC);

CREATE INDEX idx_purchases_description_norm ON public.purchases USING btree (description_norm);

CREATE INDEX idx_purchases_sort_order_book ON public.purchases USING btree (book_id, sheet_order, row_num);

CREATE INDEX idx_movements_date ON public.movements USING btree (date);

CREATE INDEX idx_movements_origin ON public.movements USING btree (origin);

CREATE INDEX idx_movements_product ON public.movements USING btree (product_id);

CREATE INDEX idx_movements_responsible ON public.movements USING btree (responsible_id, date DESC) WHERE (responsible_id IS NOT NULL);

CREATE INDEX idx_movements_over_negative ON public.movements USING btree (product_id, date DESC) WHERE over_negative;

CREATE INDEX idx_product_codes_product ON public.product_codes USING btree (product_id);

CREATE INDEX idx_products_category_id ON public.products USING btree (category_id);

CREATE INDEX idx_products_group_name ON public.products USING btree (group_name) WHERE (group_name IS NOT NULL);

CREATE INDEX idx_products_brand ON public.products USING btree (brand) WHERE (brand IS NOT NULL);

CREATE INDEX idx_restock_product ON public.restock_requests USING btree (product_id, requested_at DESC);

CREATE INDEX idx_sessions_open ON public.sessions USING btree (user_id, expires_at DESC) WHERE (closed_at IS NULL);

CREATE INDEX idx_sessions_token ON public.sessions USING btree (token_hash);

CREATE INDEX book_imports_book_idx ON public.book_imports USING btree (book_id, done_at DESC);

CREATE INDEX product_aliases_import_idx ON public.product_aliases USING btree (import_id) WHERE (import_id IS NOT NULL);

CREATE INDEX product_changes_product_idx ON public.product_changes USING btree (product_id, done_at DESC);

CREATE INDEX supplier_aliases_supplier_idx ON public.supplier_aliases USING btree (supplier_id);

CREATE INDEX supplier_contacts_supplier_idx ON public.supplier_contacts USING btree (supplier_id);

CREATE UNIQUE INDEX suppliers_rfc_unique ON public.suppliers USING btree (rfc) WHERE (rfc IS NOT NULL);

CREATE INDEX push_subscriptions_user_idx ON public.push_subscriptions USING btree (user_id);

CREATE INDEX backups_done_at_idx ON public.backups USING btree (done_at DESC);

CREATE INDEX request_items_request_idx ON public.request_items USING btree (request_id);

CREATE INDEX material_requests_status_idx ON public.material_requests USING btree (status, created_at);

CREATE INDEX material_requests_requester_idx ON public.material_requests USING btree (requester_id, created_at DESC);

CREATE UNIQUE INDEX uq_product_aliases_alias_norm ON public.product_aliases USING btree (alias_norm);

CREATE UNIQUE INDEX uq_restock_open ON public.restock_requests USING btree (product_id) WHERE (handled_at IS NULL);

CREATE UNIQUE INDEX users_username_unique ON public.users USING btree (lower(username));

ALTER TABLE ONLY public.user_audit_log
    ADD CONSTRAINT user_audit_log_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.user_audit_log
    ADD CONSTRAINT user_audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_parent_category_id_fkey FOREIGN KEY (parent_category_id) REFERENCES public.categories(id);

ALTER TABLE ONLY public.purchases
    ADD CONSTRAINT purchases_import_id_fkey FOREIGN KEY (import_id) REFERENCES public.book_imports(id);

ALTER TABLE ONLY public.purchases
    ADD CONSTRAINT purchases_book_id_fkey FOREIGN KEY (book_id) REFERENCES public.purchase_books(id);

ALTER TABLE ONLY public.purchases
    ADD CONSTRAINT purchases_movement_id_fkey FOREIGN KEY (movement_id) REFERENCES public.movements(id);

ALTER TABLE ONLY public.purchases
    ADD CONSTRAINT purchases_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id);

ALTER TABLE ONLY public.invoice_files
    ADD CONSTRAINT invoice_files_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.invoice_files
    ADD CONSTRAINT invoice_files_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.invoice_lines
    ADD CONSTRAINT invoice_lines_reconciled_by_fkey FOREIGN KEY (reconciled_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.invoice_lines
    ADD CONSTRAINT invoice_lines_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.invoice_lines
    ADD CONSTRAINT invoice_lines_movement_id_fkey FOREIGN KEY (movement_id) REFERENCES public.movements(id);

ALTER TABLE ONLY public.invoice_lines
    ADD CONSTRAINT invoice_lines_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_captured_by_fkey FOREIGN KEY (captured_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.deleted_invoices
    ADD CONSTRAINT deleted_invoices_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id);

ALTER TABLE ONLY public.book_imports
    ADD CONSTRAINT book_imports_undone_by_fkey FOREIGN KEY (undone_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.book_imports
    ADD CONSTRAINT book_imports_book_id_fkey FOREIGN KEY (book_id) REFERENCES public.purchase_books(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.book_imports
    ADD CONSTRAINT book_imports_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.movements
    ADD CONSTRAINT movements_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);

ALTER TABLE ONLY public.movements
    ADD CONSTRAINT movements_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id);

ALTER TABLE ONLY public.movements
    ADD CONSTRAINT movements_responsible_id_fkey FOREIGN KEY (responsible_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.movements
    ADD CONSTRAINT movements_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.product_aliases
    ADD CONSTRAINT product_aliases_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.product_aliases
    ADD CONSTRAINT product_aliases_import_id_fkey FOREIGN KEY (import_id) REFERENCES public.book_imports(id);

ALTER TABLE ONLY public.product_aliases
    ADD CONSTRAINT product_aliases_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.product_codes
    ADD CONSTRAINT product_codes_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.product_codes
    ADD CONSTRAINT product_codes_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.product_changes
    ADD CONSTRAINT product_changes_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.product_changes
    ADD CONSTRAINT product_changes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id);

ALTER TABLE ONLY public.supplier_aliases
    ADD CONSTRAINT supplier_aliases_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.supplier_aliases
    ADD CONSTRAINT supplier_aliases_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.supplier_contacts
    ADD CONSTRAINT supplier_contacts_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.request_items
    ADD CONSTRAINT request_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);

ALTER TABLE ONLY public.request_items
    ADD CONSTRAINT request_items_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.material_requests(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.material_requests
    ADD CONSTRAINT material_requests_handled_by_fkey FOREIGN KEY (handled_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.material_requests
    ADD CONSTRAINT material_requests_requester_id_fkey FOREIGN KEY (requester_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.restock_requests
    ADD CONSTRAINT restock_requests_movement_id_fkey FOREIGN KEY (movement_id) REFERENCES public.movements(id);

ALTER TABLE ONLY public.restock_requests
    ADD CONSTRAINT restock_requests_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);

ALTER TABLE ONLY public.restock_requests
    ADD CONSTRAINT restock_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id);
