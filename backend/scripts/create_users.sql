-- Create demo users directly in the database
-- Passwords are hashed using bcrypt: admin123, engineer123, viewer123

-- Admin user
INSERT INTO "user" (id, email, full_name, role, hashed_password, created_at, updated_at)
VALUES (
    gen_random_uuid(),
    'admin@example.com',
    'Admin User',
    'admin',
    '$2b$12$/.0PZbW5fBXCM46jLhvx0O8iVJl6gK3mIKiGjfly9V0e/CFc084Wu',  -- admin123
    NOW(),
    NOW()
)
ON CONFLICT (email) DO NOTHING;

-- Engineer user
INSERT INTO "user" (id, email, full_name, role, hashed_password, created_at, updated_at)
VALUES (
    gen_random_uuid(),
    'engineer@example.com',
    'Engineer User',
    'engineer',
    '$2b$12$WbetGKhhQmWoLglbnUS2Bu2DdjB3JcDz5E6vLrl2wOwFvivBWw9oe',  -- engineer123
    NOW(),
    NOW()
)
ON CONFLICT (email) DO NOTHING;

-- Viewer user
INSERT INTO "user" (id, email, full_name, role, hashed_password, created_at, updated_at)
VALUES (
    gen_random_uuid(),
    'viewer@example.com',
    'Viewer User',
    'viewer',
    '$2b$12$NBCVd0HvNs/OULmjMoVOx.pgEMTlss1r8va5fQ9z2vy4Tjqz11Hz2',  -- viewer123
    NOW(),
    NOW()
)
ON CONFLICT (email) DO NOTHING;
