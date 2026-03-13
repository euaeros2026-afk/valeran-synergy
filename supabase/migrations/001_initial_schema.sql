-- ============================================================
-- VALERAN · SYNERGY VENTURES · DATABASE SCHEMA
-- ============================================================

-- Enable UUID generation
create extension if not exists "uuid-ossp";
create extension if not exists "pg_trgm"; -- for fuzzy search

-- ============================================================
-- PARTNERS (team members)
-- ============================================================
create table partners (
  id uuid primary key default uuid_generate_v4(),
  email text unique not null,
  full_name text not null,
  display_name text,
  role text not null default 'founder', -- founder | investor | observer
  preferred_language text not null default 'en', -- en | ru | bg
  at_fair boolean default true,
  telegram_user_id bigint,
  communication_style jsonb default '{}', -- learned by Valeran over time
  focus_categories text[], -- categories this partner tends to cover
  avatar_url text,
  created_at timestamptz default now(),
  last_active_at timestamptz
);

-- ============================================================
-- FAIR SESSIONS (the 3 phases)
-- ============================================================
create table fair_sessions (
  id uuid primary key default uuid_generate_v4(),
  phase_number int not null, -- 1, 2, 3
  name text not null,
  start_date date not null,
  end_date date not null,
  sections text[], -- Canton Fair official sections in this phase
  status text default 'upcoming' -- upcoming | active | completed
);

-- Pre-load Canton Fair 2025 phases
insert into fair_sessions (phase_number, name, start_date, end_date, sections, status) values
(1, 'Phase 1', '2025-04-15', '2025-04-19', array[
  'Household Electrical Appliances',
  'Consumer Electronics and Information Products',
  'Industrial Automation and Intelligent Manufacturing',
  'Processing Machinery Equipment',
  'Power Machinery and Electric Power',
  'General Machinery and Mechanical Basic Parts',
  'Construction Machinery',
  'Agricultural Machinery',
  'New Materials and Chemical Products',
  'New Energy Vehicles and Smart Mobility',
  'Vehicles','Vehicle Spare Parts','Motorcycles','Bicycles',
  'Lighting Equipment',
  'Electronic and Electrical Products',
  'New Energy Resources',
  'Hardware','Tools'
], 'upcoming'),
(2, 'Phase 2', '2025-04-23', '2025-04-27', array[
  'General Ceramics',
  'Kitchenware and Tableware',
  'Household Items',
  'Glass Artware',
  'Home Decorations',
  'Gardening Products',
  'Festival Products',
  'Gifts and Premiums',
  'Clocks, Watches and Optical Instruments',
  'Art Ceramics',
  'Weaving, Rattan and Iron Products',
  'Building and Decorative Materials',
  'Sanitary and Bathroom Equipment',
  'Furniture',
  'Prefabricated House and Courtyard Facilities'
], 'upcoming'),
(3, 'Phase 3', '2025-05-01', '2025-05-05', array[
  'Toys',
  'Children, Baby and Maternity Products',
  'Kids Wear',
  'Men and Women Clothing',
  'Underwear',
  'Sports and Casual Wear',
  'Furs, Leather, Downs and Related Products',
  'Fashion Accessories and Fittings',
  'Textile Raw Materials and Fabrics',
  'Shoes',
  'Cases and Bags',
  'Home Textiles',
  'Carpets and Tapestries',
  'Office Supplies',
  'Medicines, Health Products and Medical Devices',
  'Food',
  'Sports, Travel and Recreation Products',
  'Personal Care Products',
  'Toiletries',
  'Pet Products and Food',
  'Traditional Chinese Specialties'
], 'upcoming');

-- ============================================================
-- CATEGORIES (AI-managed, pre-seeded from Canton Fair)
-- ============================================================
create table categories (
  id uuid primary key default uuid_generate_v4(),
  name text unique not null,
  parent_category text,
  canton_fair_section text, -- maps to official fair section
  canton_fair_phase int,    -- 1, 2, or 3
  product_count int default 0,
  avg_score numeric(3,2),
  eu_market_size_estimate text, -- scraped/estimated
  created_by text default 'system', -- system | partner_name
  created_at timestamptz default now()
);

-- ============================================================
-- SUPPLIERS
-- ============================================================
create table suppliers (
  id uuid primary key default uuid_generate_v4(),

  -- Identity
  company_name text not null,
  company_name_chinese text,
  trade_name text,
  factory_city text,
  factory_province text,
  factory_distance_guangzhou text,
  years_in_business int,
  founded_year int,

  -- Fair location
  hall text,
  booth_number text,
  fair_session_id uuid references fair_sessions(id),

  -- Contact
  contact_name text,
  contact_title text,
  contact_phone text,
  contact_wechat text,
  contact_email text,
  business_card_photo_url text,
  business_card_raw_text text, -- OCR output

  -- Platforms
  on_alibaba boolean,
  alibaba_store_url text,
  alibaba_gold_supplier boolean,
  alibaba_years int,
  alibaba_trade_assurance boolean,
  on_1688 boolean,
  store_1688_url text,

  -- Capabilities
  oem_available boolean default false,
  odm_available boolean default false,
  private_label boolean default false,
  custom_packaging boolean default false,
  annual_production_capacity text,
  export_experience boolean,
  knows_eu_market boolean,
  currently_selling_eu boolean,
  eu_brands_supplied text[], -- brands they supply in EU if disclosed

  -- Certifications (supplier level)
  has_ce boolean,
  has_rohs boolean,
  has_iso boolean,
  has_reach boolean,
  other_certifications text[],

  -- Commercial terms
  payment_terms text[], -- T/T, L/C, Trade Assurance
  incoterms text[], -- FOB, CIF, EXW
  min_order_value_usd numeric(10,2),
  sample_policy text,

  -- Intelligence
  competitor_products_made text[],
  team_reliability_score int check (team_reliability_score between 1 and 5),
  overall_supplier_score numeric(3,2), -- auto-calculated
  notes text,

  -- Meta
  logged_by uuid references partners(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  fair_phase int
);

-- ============================================================
-- PRODUCTS
-- ============================================================
create table products (
  id uuid primary key default uuid_generate_v4(),

  -- Links
  supplier_id uuid references suppliers(id) on delete cascade,
  category_id uuid references categories(id),
  fair_session_id uuid references fair_sessions(id),

  -- Identity
  product_name text not null,
  model_number text,
  category_auto text,      -- AI-assigned
  category_confirmed text, -- team-confirmed (can override)
  subcategory text,        -- AI-assigned
  hs_code_estimate text,   -- AI-estimated
  hs_customs_duty_rate numeric(5,2), -- % duty for EU import

  -- Specs
  materials text,
  dimensions text,
  weight_grams int,
  power_specs text,
  connectivity text,
  key_features text[],
  variants text[], -- colours, sizes
  packaging_type text,
  packaging_dimensions text,
  units_per_carton int,

  -- Pricing & terms
  exworks_price_cny_min numeric(10,2),
  exworks_price_cny_max numeric(10,2),
  exworks_price_usd_min numeric(10,2),
  exworks_price_usd_max numeric(10,2),
  moq_standard int,
  moq_negotiated int,
  sample_cost_usd numeric(10,2),
  sample_lead_time_days int,
  production_lead_time_days int,
  production_lead_time_oem_days int,

  -- Compliance (product level)
  ce_status text, -- held | obtainable | unknown | not_required
  rohs_status text,
  reach_status text,
  weee_applicable boolean,
  en_standards_required text[],
  compliance_cost_estimate_usd numeric(10,2), -- AI-estimated
  other_compliance_notes text,

  -- Market intelligence (auto-scraped)
  eu_avg_price_eur numeric(10,2),
  eu_price_range_min numeric(10,2),
  eu_price_range_max numeric(10,2),
  eu_top_competitors jsonb default '[]', -- [{name, price, rating, reviews, platform}]
  eu_review_insights jsonb default '{}', -- {top_complaints: [], top_praise: [], gaps: []}
  china_price_floor_cny numeric(10,2),   -- lowest found on 1688
  china_source_matches jsonb default '[]', -- [{platform, url, price, moq}]
  gross_margin_estimate numeric(5,2),    -- % after freight, duties, VAT, fees

  -- Search data
  image_search_done boolean default false,
  image_search_at timestamptz,
  search_keywords text[],

  -- 5-dimension score (auto)
  score_category_attractiveness numeric(3,2),
  score_product_demand numeric(3,2),
  score_competition_difficulty numeric(3,2),
  score_sourcing_feasibility numeric(3,2),
  score_margin_quality numeric(3,2),
  total_score numeric(3,2), -- weighted average

  -- Decision
  status text default 'reviewing', -- reviewing | shortlisted | rejected | follow_up
  team_recommendation text,

  -- Photos
  photo_urls text[], -- stored in Google Drive
  thumbnail_url text,

  -- Meta
  logged_by uuid references partners(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  fair_phase int
);

-- ============================================================
-- MEETINGS & SCHEDULE
-- ============================================================
create table meetings (
  id uuid primary key default uuid_generate_v4(),
  supplier_id uuid references suppliers(id),
  title text not null,
  meeting_date date not null,
  meeting_time time not null,
  location text, -- hall, booth, or factory address
  contact_name text,
  contact_phone text,
  agenda text,
  notes text,
  status text default 'scheduled', -- scheduled | completed | cancelled
  created_by uuid references partners(id),
  created_at timestamptz default now(),
  fair_phase int
);

-- ============================================================
-- CHAT MESSAGES (Valeran conversation log)
-- ============================================================
create table messages (
  id uuid primary key default uuid_generate_v4(),
  sender_id uuid references partners(id), -- null = Valeran
  sender_type text not null, -- partner | valeran
  content text not null,
  content_translated jsonb default '{}', -- {bg: '...', ru: '...', en: '...'}
  message_type text default 'text', -- text | voice | photo | doc | report
  media_url text,
  media_type text,

  -- AI extraction
  extracted_supplier_id uuid references suppliers(id),
  extracted_product_id uuid references products(id),
  extracted_meeting_id uuid references meetings(id),
  tags text[], -- what Valeran identified in this message
  valeran_triggered boolean default false, -- was "Valeran" called?

  -- Meta
  telegram_message_id bigint,
  fair_session_id uuid references fair_sessions(id),
  created_at timestamptz default now()
);

-- ============================================================
-- DAILY REPORTS
-- ============================================================
create table reports (
  id uuid primary key default uuid_generate_v4(),
  report_type text not null, -- evening | morning | stage | final
  fair_session_id uuid references fair_sessions(id),
  report_date date not null,
  title text not null,

  -- Content
  content_en text,
  content_bg text,
  content_ru text,

  -- Stats snapshot
  stats jsonb default '{}', -- {products_logged, suppliers_met, high_score_items, ...}
  top_products jsonb default '[]',
  meetings_tomorrow jsonb default '[]',
  recommendations jsonb default '[]',

  -- Delivery
  sent_to_telegram boolean default false,
  google_doc_url text,
  created_at timestamptz default now()
);

-- ============================================================
-- INDEXES for performance
-- ============================================================
create index on suppliers(fair_session_id);
create index on suppliers(overall_supplier_score desc);
create index on products(supplier_id);
create index on products(category_id);
create index on products(total_score desc);
create index on products(status);
create index on products(fair_phase);
create index on messages(created_at desc);
create index on messages(sender_id);
create index on meetings(meeting_date);

-- Full text search on products
create index on products using gin(to_tsvector('english', coalesce(product_name,'') || ' ' || coalesce(category_auto,'') || ' ' || coalesce(materials,'')));

-- ============================================================
-- ROW LEVEL SECURITY (only authenticated partners can access)
-- ============================================================
alter table partners enable row level security;
alter table suppliers enable row level security;
alter table products enable row level security;
alter table messages enable row level security;
alter table meetings enable row level security;
alter table reports enable row level security;
alter table categories enable row level security;
alter table fair_sessions enable row level security;

-- Partners can read/write everything (simple policy for MVP)
create policy "authenticated_access" on partners for all using (auth.role() = 'authenticated');
create policy "authenticated_access" on suppliers for all using (auth.role() = 'authenticated');
create policy "authenticated_access" on products for all using (auth.role() = 'authenticated');
create policy "authenticated_access" on messages for all using (auth.role() = 'authenticated');
create policy "authenticated_access" on meetings for all using (auth.role() = 'authenticated');
create policy "authenticated_access" on reports for all using (auth.role() = 'authenticated');
create policy "authenticated_access" on categories for all using (auth.role() = 'authenticated');
create policy "authenticated_access" on fair_sessions for all using (auth.role() = 'authenticated');

-- ============================================================
-- FUNCTION: auto-update updated_at
-- ============================================================
create or replace function update_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger update_suppliers_updated_at before update on suppliers for each row execute function update_updated_at();
create trigger update_products_updated_at before update on products for each row execute function update_updated_at();
