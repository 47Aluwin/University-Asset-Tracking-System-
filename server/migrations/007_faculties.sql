-- Faculties of the PNG University of Technology, and the schools / units under them.
-- A school is a department (it keeps owning assets, locations and access rights); this adds the faculty
-- it belongs to. A department with no faculty is a central administrative unit (e.g. Finance, Library).
-- An asset's faculty always comes from its owning school, so the two can never disagree.

CREATE TABLE faculties (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{2,12}$'),
  name        text NOT NULL UNIQUE CHECK (length(trim(name)) BETWEEN 2 AND 200),
  sort_order  integer NOT NULL DEFAULT 100,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE departments ADD COLUMN faculty_id uuid REFERENCES faculties(id);
CREATE INDEX departments_faculty_idx ON departments (faculty_id);

-- Who the asset is assigned to (custodian), and whether it is in use. Both are plain record fields.
ALTER TABLE assets ADD COLUMN assigned_to text CHECK (assigned_to IS NULL OR length(trim(assigned_to)) BETWEEN 2 AND 200);
ALTER TABLE assets ADD COLUMN usage_status text NOT NULL DEFAULT 'in_use'
  CHECK (usage_status IN ('in_use', 'in_storage', 'not_in_use', 'awaiting_disposal'));

INSERT INTO faculties (code, name, sort_order) VALUES
  ('FENG',  'Faculty of Engineering', 10),
  ('FSCI',  'Faculty of Sciences', 20),
  ('FNR',   'Faculty of Natural Resources', 30),
  ('FHUM',  'Faculty of Humanities', 40),
  ('FBE',   'Faculty of Built Environment', 50),
  ('FPGRI', 'Faculty of Postgraduate Studies, Research, and Innovation', 60)
ON CONFLICT (code) DO NOTHING;

-- Schools (default currency: Papua New Guinea kina). Existing departments with the same code are left as they are.
INSERT INTO departments (code, name, default_currency, faculty_id)
SELECT s.code, s.name, 'PGK', f.id
  FROM (VALUES
    ('CIVIL',   'School of Civil Engineering', 'FENG'),
    ('ECE',     'School of Electrical and Communication Engineering', 'FENG'),
    ('MECH',    'School of Mechanical Engineering', 'FENG'),
    ('MINING',  'School of Mining Engineering', 'FENG'),
    ('APPHYS',  'School of Applied Physics', 'FSCI'),
    ('APPSCI',  'School of Applied Sciences', 'FSCI'),
    ('MCS',     'School of Mathematics and Computer Science', 'FSCI'),
    ('AGRI',    'School of Agriculture', 'FNR'),
    ('FOREST',  'School of Forestry', 'FNR'),
    ('BUS',     'School of Business Studies', 'FHUM'),
    ('CDS',     'School of Communication and Development Studies', 'FHUM'),
    ('ACM',     'School of Architecture and Construction Management', 'FBE'),
    ('SLS',     'School of Surveying and Land Studies', 'FBE'),
    -- The postgraduate faculty's own office; administrators add its research units/centres as needed.
    ('PGSRI',   'Postgraduate Studies, Research and Innovation Office', 'FPGRI')
  ) AS s(code, name, faculty_code)
  JOIN faculties f ON f.code = s.faculty_code
ON CONFLICT (code) DO NOTHING;

-- Central administrative units (no faculty). Administrators can rename them or add more.
INSERT INTO departments (code, name, default_currency) VALUES
  ('LIBRARY', 'University Library', 'PGK'),
  ('SSFC',    'Student Support & Facility Centre', 'PGK')
ON CONFLICT (code) DO NOTHING;
