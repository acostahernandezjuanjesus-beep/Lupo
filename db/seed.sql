-- Reference rows every install starts with. No business data here.

INSERT INTO public.categories (id, name, parent_category_id) VALUES
    (1, 'Countersink', NULL),
    (2, 'Drill bit', NULL),
    (3, 'Brazed tool bit', NULL),
    (4, 'Torch back cap', NULL),
    (5, 'Ceramic cup', NULL),
    (6, 'Gas diffuser', NULL),
    (7, 'End mill', NULL),
    (8, 'Ball end mill', NULL),
    (9, 'Filter', NULL),
    (10, 'Rotary burr', NULL),
    (11, 'Tap', NULL),
    (12, 'Clamp', NULL),
    (13, 'Pneumatics', NULL),
    (14, 'Set screw', NULL),
    (15, 'Oxy-fuel cutting', NULL),
    (16, 'Contact tip', NULL),
    (17, 'Reamer', NULL),
    (18, 'Threading die', NULL),
    (19, 'Welding nozzle', NULL),
    (20, 'Uncategorized', NULL),
    (22, 'Cleaning and hygiene', NULL),
    (23, 'Cutting tools', NULL),
    (24, 'Industrial gases', NULL),
    (25, 'Lubricants and chemicals', NULL),
    (26, 'Abrasives and discs', NULL),
    (27, 'Welding consumables', NULL),
    (28, 'Personal protective equipment', NULL),
    (29, 'Hand tools', NULL),
    (30, 'Electrical supplies', NULL),
    (31, 'Tapes', NULL),
    (32, 'Packaging', NULL);

SELECT setval('public.categories_id_seq', (SELECT max(id) FROM public.categories));

-- name_norm is generated
INSERT INTO public.supplier_tags (name) VALUES
    ('Abrasives'), ('Oils and coolants'), ('Steel'), ('Bearings'), ('Gases'), ('Cutting tools'),
    ('Cleaning'), ('Machinery'), ('Measurement'), ('Office and IT'), ('Paint'), ('Safety'),
    ('Service'), ('Welding'), ('Fasteners');
