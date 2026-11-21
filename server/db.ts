import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  decryptPHI,
  decryptPHIWithKey,
  encryptPHI,
  getLegacyRuntimeAesKey,
  hashPassword,
} from './security.ts';

const dbPath = path.resolve(
  process.cwd(),
  process.env.DB_PATH || './data/netanya_pharmacy.db'
);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

export function nextSequence(name: string, defaultStart = 1000): number {
  db.prepare(`INSERT OR IGNORE INTO sequences (name, current_value) VALUES (?, ?)`).run(
    name,
    defaultStart
  );
  const row = db
    .prepare(
      `UPDATE sequences SET current_value = current_value + 1 WHERE name = ? RETURNING current_value`
    )
    .get(name) as { current_value: number };
  return Number(row.current_value);
}

export function initializeDatabase(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('patient','pharmacist','supplier','owner')),
      consent_accepted_at TEXT,
      marketing_opt_in INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS patients_phi (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      encrypted_payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id TEXT PRIMARY KEY,
      ndc_code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      image_url TEXT,
      manufacturer_name TEXT NOT NULL DEFAULT '',
      active_ingredient TEXT NOT NULL DEFAULT '',
      dosage_form TEXT NOT NULL DEFAULT '',
      usage_directions TEXT NOT NULL DEFAULT '',
      warnings TEXT NOT NULL DEFAULT '',
      storage_info TEXT NOT NULL DEFAULT '',
      official_source_url TEXT,
      unit_price_cents INTEGER NOT NULL,
      cost_price_cents INTEGER NOT NULL,
      stock_quantity INTEGER NOT NULL,
      reorder_threshold INTEGER NOT NULL,
      reorder_quantity INTEGER NOT NULL,
      lot_number TEXT NOT NULL,
      expiry_date TEXT NOT NULL,
      supplier_id TEXT NOT NULL,
      supplier_name TEXT NOT NULL,
      auto_reorder_enabled INTEGER NOT NULL DEFAULT 1,
      requires_prescription INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS insurance_plans (
      id TEXT PRIMARY KEY,
      payer_name TEXT NOT NULL,
      bin TEXT NOT NULL,
      pcn TEXT NOT NULL,
      group_prefix TEXT NOT NULL,
      tier1_copay_cents INTEGER NOT NULL,
      tier2_copay_cents INTEGER NOT NULL,
      tier3_copay_cents INTEGER NOT NULL,
      reimbursement_rate REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prescriptions (
      id TEXT PRIMARY KEY,
      rx_number TEXT UNIQUE NOT NULL,
      patient_id TEXT NOT NULL REFERENCES users(id),
      patient_name TEXT NOT NULL,
      inventory_id TEXT NOT NULL REFERENCES inventory(id),
      medication_name TEXT NOT NULL,
      ndc_code TEXT NOT NULL,
      prescriber_name TEXT NOT NULL,
      dosage_instructions TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      days_supply INTEGER NOT NULL,
      refills_remaining INTEGER NOT NULL,
      next_refill_eligible_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('submitted','verifying','insurance_hold','ready','dispensed')),
      unit_price_cents INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS care_plans (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL REFERENCES users(id),
      patient_name TEXT NOT NULL,
      pharmacist_name TEXT NOT NULL,
      condition_focus TEXT NOT NULL,
      clinical_goals TEXT NOT NULL,
      interaction_warnings TEXT NOT NULL,
      adherence_notes TEXT NOT NULL,
      follow_up_date TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS insurance_claims (
      id TEXT PRIMARY KEY,
      claim_number TEXT UNIQUE NOT NULL,
      prescription_id TEXT NOT NULL REFERENCES prescriptions(id),
      rx_number TEXT NOT NULL,
      patient_id TEXT NOT NULL REFERENCES users(id),
      patient_name TEXT NOT NULL,
      medication_name TEXT NOT NULL,
      payer_name TEXT NOT NULL,
      bin TEXT NOT NULL,
      pcn TEXT NOT NULL,
      group_id TEXT NOT NULL,
      formulary_tier INTEGER NOT NULL,
      daw_code TEXT NOT NULL,
      days_supply INTEGER NOT NULL,
      uc_price_cents INTEGER NOT NULL,
      allowed_amount_cents INTEGER NOT NULL,
      insurer_paid_cents INTEGER NOT NULL,
      deductible_applied_cents INTEGER NOT NULL,
      patient_copay_cents INTEGER NOT NULL,
      rejection_code TEXT NOT NULL,
      rejection_message TEXT NOT NULL,
      override_code TEXT NOT NULL,
      override_notes TEXT NOT NULL,
      claim_status TEXT NOT NULL CHECK(claim_status IN ('draft','rejected','adjudicated','paid')),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS replenishment_orders (
      id TEXT PRIMARY KEY,
      po_number TEXT UNIQUE NOT NULL,
      inventory_id TEXT NOT NULL REFERENCES inventory(id),
      medication_name TEXT NOT NULL,
      ndc_code TEXT NOT NULL,
      supplier_id TEXT NOT NULL,
      supplier_name TEXT NOT NULL,
      requested_qty INTEGER NOT NULL,
      confirmed_qty INTEGER,
      batch_number TEXT,
      batch_expiry TEXT,
      scheduled_delivery_date TEXT,
      delivery_window TEXT,
      status TEXT NOT NULL CHECK(status IN ('awaiting_supplier','confirmed_scheduled','in_transit','received')),
      auto_triggered INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS medication_reminders (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL REFERENCES users(id),
      medication_name TEXT NOT NULL,
      dosage_label TEXT NOT NULL,
      time_of_day TEXT NOT NULL,
      frequency TEXT NOT NULL,
      push_enabled INTEGER NOT NULL DEFAULT 1,
      last_taken_date TEXT,
      adherence_streak INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS consultations (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL REFERENCES users(id),
      patient_name TEXT NOT NULL,
      subject TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open','resolved')),
      last_message_at TEXT NOT NULL,
      unread_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS consultation_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      sender_role TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS otc_orders (
      id TEXT PRIMARY KEY,
      order_number TEXT UNIQUE NOT NULL,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      fulfillment_type TEXT NOT NULL CHECK(fulfillment_type IN ('pickup','delivery')),
      shipping_address TEXT NOT NULL,
      items_json TEXT NOT NULL,
      subtotal_cents INTEGER NOT NULL,
      tax_cents INTEGER NOT NULL,
      total_cents INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      actor_name TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sequences (
      name TEXT PRIMARY KEY,
      current_value INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pos_transactions (
      id TEXT PRIMARY KEY,
      receipt_number TEXT UNIQUE NOT NULL,
      cashier_id TEXT NOT NULL,
      cashier_name TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      payment_method TEXT NOT NULL CHECK(payment_method IN ('cash','card','mobile_pay')),
      discount_percent INTEGER NOT NULL DEFAULT 0,
      otc_lines_json TEXT NOT NULL,
      rx_lines_json TEXT NOT NULL,
      service_lines_json TEXT NOT NULL DEFAULT '[]',
      subtotal_cents INTEGER NOT NULL,
      discount_cents INTEGER NOT NULL,
      tax_cents INTEGER NOT NULL,
      rx_copay_total_cents INTEGER NOT NULL,
      service_total_cents INTEGER NOT NULL DEFAULT 0,
      grand_total_cents INTEGER NOT NULL,
      tendered_cents INTEGER NOT NULL,
      change_due_cents INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pharmacy_services (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      turnaround_minutes INTEGER NOT NULL,
      price_cents INTEGER NOT NULL,
      notes TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS service_logs (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL REFERENCES pharmacy_services(id),
      service_name TEXT NOT NULL,
      patient_name TEXT NOT NULL,
      result_value TEXT NOT NULL,
      notes TEXT NOT NULL,
      price_cents INTEGER NOT NULL,
      recorded_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cash_drawer_events (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      actor_name TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      reason TEXT NOT NULL,
      receipt_number TEXT,
      hardware_transport TEXT NOT NULL,
      authorized_at TEXT NOT NULL
    );
  `);

  // Safely drop legacy 3-value CHECK(category IN ('Rx','OTC','Wellness')) if upgrading an existing DB
  const invTableMeta = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inventory'`)
    .get() as { sql?: string } | undefined;
  if (invTableMeta?.sql && invTableMeta.sql.includes("'Wellness'")) {
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec(`
      BEGIN;
      CREATE TABLE inventory_migrated (
        id TEXT PRIMARY KEY,
        ndc_code TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        image_url TEXT,
        unit_price_cents INTEGER NOT NULL,
        cost_price_cents INTEGER NOT NULL,
        stock_quantity INTEGER NOT NULL,
        reorder_threshold INTEGER NOT NULL,
        reorder_quantity INTEGER NOT NULL,
        lot_number TEXT NOT NULL,
        expiry_date TEXT NOT NULL,
        supplier_id TEXT NOT NULL,
        supplier_name TEXT NOT NULL,
        auto_reorder_enabled INTEGER NOT NULL DEFAULT 1,
        requires_prescription INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO inventory_migrated (
        id, ndc_code, name, category, description, image_url,
        unit_price_cents, cost_price_cents, stock_quantity, reorder_threshold, reorder_quantity,
        lot_number, expiry_date, supplier_id, supplier_name, auto_reorder_enabled, requires_prescription
      )
      SELECT
        id, ndc_code, name, category, description, image_url,
        unit_price_cents, cost_price_cents, stock_quantity, reorder_threshold, reorder_quantity,
        lot_number, expiry_date, supplier_id, supplier_name, auto_reorder_enabled, requires_prescription
      FROM inventory;
      DROP TABLE inventory;
      ALTER TABLE inventory_migrated RENAME TO inventory;
      COMMIT;
    `);
    db.exec('PRAGMA foreign_keys = ON;');
  }

  // Idempotently add service columns to pos_transactions on existing DBs
  const posCols = db.prepare(`PRAGMA table_info(pos_transactions)`).all() as Array<{ name: string }>;
  const posColNames = new Set(posCols.map((c) => c.name));
  if (!posColNames.has('service_lines_json')) {
    db.exec(`ALTER TABLE pos_transactions ADD COLUMN service_lines_json TEXT NOT NULL DEFAULT '[]';`);
  }
  if (!posColNames.has('service_total_cents')) {
    db.exec(`ALTER TABLE pos_transactions ADD COLUMN service_total_cents INTEGER NOT NULL DEFAULT 0;`);
  }

  // Idempotently add official manufacturer info columns to inventory on existing DBs
  const invCols = db.prepare(`PRAGMA table_info(inventory)`).all() as Array<{ name: string }>;
  const invColNames = new Set(invCols.map((c) => c.name));
  if (!invColNames.has('manufacturer_name')) {
    db.exec(`ALTER TABLE inventory ADD COLUMN manufacturer_name TEXT NOT NULL DEFAULT '';`);
  }
  if (!invColNames.has('active_ingredient')) {
    db.exec(`ALTER TABLE inventory ADD COLUMN active_ingredient TEXT NOT NULL DEFAULT '';`);
  }
  if (!invColNames.has('dosage_form')) {
    db.exec(`ALTER TABLE inventory ADD COLUMN dosage_form TEXT NOT NULL DEFAULT '';`);
  }
  if (!invColNames.has('usage_directions')) {
    db.exec(`ALTER TABLE inventory ADD COLUMN usage_directions TEXT NOT NULL DEFAULT '';`);
  }
  if (!invColNames.has('warnings')) {
    db.exec(`ALTER TABLE inventory ADD COLUMN warnings TEXT NOT NULL DEFAULT '';`);
  }
  if (!invColNames.has('storage_info')) {
    db.exec(`ALTER TABLE inventory ADD COLUMN storage_info TEXT NOT NULL DEFAULT '';`);
  }
  if (!invColNames.has('official_source_url')) {
    db.exec(`ALTER TABLE inventory ADD COLUMN official_source_url TEXT;`);
  }

  const seedSeq = db.prepare(
    `INSERT OR IGNORE INTO sequences (name, current_value) VALUES (?, ?)`
  );
  seedSeq.run('rx_seq', 8854);
  seedSeq.run('po_seq', 3002);
  seedSeq.run('ord_seq', 77102);
  seedSeq.run('clm_seq', 99019);
  seedSeq.run('pos_seq', 10000);
  seedSeq.run('lot_seq', 6000);
  seedSeq.run('nrx_seq', 99412055);

  const existingUsers = db.prepare('SELECT COUNT(*) as count FROM users').get() as {
    count: number;
  };
  if (existingUsers.count > 0) {
    const legacyKey = getLegacyRuntimeAesKey();
    const phiRows = db
      .prepare('SELECT user_id, encrypted_payload FROM patients_phi')
      .all() as Array<{ user_id: string; encrypted_payload: string }>;
    const updateStmt = db.prepare(
      'UPDATE patients_phi SET encrypted_payload = ?, updated_at = ? WHERE user_id = ?'
    );
    const nowIso = new Date().toISOString();
    for (const row of phiRows) {
      try {
        decryptPHI(row.encrypted_payload);
      } catch {
        let migrated = false;
        if (legacyKey) {
          try {
            const plain = decryptPHIWithKey(row.encrypted_payload, legacyKey);
            updateStmt.run(encryptPHI(plain), nowIso, row.user_id);
            migrated = true;
          } catch {
            // Fall through to seeded record recovery if applicable
          }
        }
        if (!migrated && row.user_id === 'usr_patient_maya') {
          updateStmt.run(
            encryptPHI({
              dob: '1988-04-12',
              phone: '+233 24 418 8910',
              address: '14 Liberation Rd, East Legon, Accra · GA-312-4490',
              allergies: ['Penicillin (Rash)', 'Sulfa Drugs'],
              insuranceProvider: 'NHIS (National Health Insurance)',
              bin: '233001',
              pcn: 'NHISGH',
              groupNumber: 'NHIS-88420',
              memberId: 'GHA-NHIS-99412055',
            }),
            nowIso,
            row.user_id
          );
        } else if (!migrated && row.user_id === 'usr_patient_marcus') {
          updateStmt.run(
            encryptPHI({
              dob: '1974-09-28',
              phone: '+233 50 609 4412',
              address: '28 Cantonments Crescent, Accra · GA-054-8821',
              allergies: ['No Known Drug Allergies'],
              insuranceProvider: 'Acacia Health Insurance',
              bin: '233002',
              pcn: 'ACACIA',
              groupNumber: 'ACA-55190',
              memberId: 'ACA-71029384',
            }),
            nowIso,
            row.user_id
          );
        }
      }
    }

    // Idempotent Ghana localization for previously seeded US placeholder records
    const hasLegacyPlans = db
      .prepare(`SELECT id FROM insurance_plans WHERE id IN ('plan_bcbs','plan_aetna','plan_uhc','plan_cigna')`)
      .get();
    if (hasLegacyPlans) {
      db.prepare(`UPDATE insurance_plans SET payer_name = 'NHIS (National Health Insurance)', bin = '233001', pcn = 'NHISGH', group_prefix = 'NHIS-', tier1_copay_cents = 500, tier2_copay_cents = 1500, tier3_copay_cents = 4500, reimbursement_rate = 0.90 WHERE id = 'plan_bcbs'`).run();
      db.prepare(`UPDATE insurance_plans SET payer_name = 'Acacia Health Insurance', bin = '233002', pcn = 'ACACIA', group_prefix = 'ACA-', tier1_copay_cents = 1000, tier2_copay_cents = 3000, tier3_copay_cents = 6500, reimbursement_rate = 0.88 WHERE id = 'plan_aetna'`).run();
      db.prepare(`UPDATE insurance_plans SET payer_name = 'Apex Health Insurance', bin = '233003', pcn = 'APEXGH', group_prefix = 'APX-', tier1_copay_cents = 1200, tier2_copay_cents = 3500, tier3_copay_cents = 7500, reimbursement_rate = 0.85 WHERE id = 'plan_uhc'`).run();
      db.prepare(`UPDATE insurance_plans SET payer_name = 'Glico Healthcare', bin = '233004', pcn = 'GLICO', group_prefix = 'GLC-', tier1_copay_cents = 1000, tier2_copay_cents = 3200, tier3_copay_cents = 7000, reimbursement_rate = 0.86 WHERE id = 'plan_cigna'`).run();

      db.prepare(`UPDATE insurance_claims SET payer_name = 'NHIS (National Health Insurance)', bin = '233001', pcn = 'NHISGH', group_id = 'NHIS-88420' WHERE payer_name = 'BlueCross Rx Shield'`).run();
      db.prepare(`UPDATE insurance_claims SET payer_name = 'Acacia Health Insurance', bin = '233002', pcn = 'ACACIA', group_id = 'ACA-55190' WHERE payer_name = 'Aetna Caremark Plus'`).run();
      db.prepare(`UPDATE inventory SET supplier_name = 'Ernest & Tobinko MedSupply Ghana' WHERE supplier_name = 'Apex MedSupply Logistics'`).run();
      db.prepare(`UPDATE replenishment_orders SET supplier_name = 'Ernest & Tobinko MedSupply Ghana' WHERE supplier_name = 'Apex MedSupply Logistics'`).run();
      db.prepare(`UPDATE users SET display_name = 'Ernest & Tobinko MedSupply Ghana' WHERE id = 'usr_supplier_apex' AND display_name = 'Apex MedSupply Logistics'`).run();
      db.prepare(`UPDATE otc_orders SET shipping_address = '14 Liberation Rd, East Legon, Accra · GA-312-4490' WHERE shipping_address LIKE '%Seattle, WA%'`).run();

      const nowIso2 = new Date().toISOString();
      const phiRowMaya = db.prepare('SELECT encrypted_payload FROM patients_phi WHERE user_id = ?').get('usr_patient_maya') as { encrypted_payload: string } | undefined;
      if (phiRowMaya) {
        try {
          const d = decryptPHI<{ insuranceProvider: string }>(phiRowMaya.encrypted_payload);
          if (d.insuranceProvider === 'BlueCross Rx Shield') {
            db.prepare('UPDATE patients_phi SET encrypted_payload = ?, updated_at = ? WHERE user_id = ?').run(
              encryptPHI({
                dob: '1988-04-12',
                phone: '+233 24 418 8910',
                address: '14 Liberation Rd, East Legon, Accra · GA-312-4490',
                allergies: ['Penicillin (Rash)', 'Sulfa Drugs'],
                insuranceProvider: 'NHIS (National Health Insurance)',
                bin: '233001',
                pcn: 'NHISGH',
                groupNumber: 'NHIS-88420',
                memberId: 'GHA-NHIS-99412055',
              }),
              nowIso2,
              'usr_patient_maya'
            );
          }
        } catch {
          // ignore
        }
      }
      const phiRowMarcus = db.prepare('SELECT encrypted_payload FROM patients_phi WHERE user_id = ?').get('usr_patient_marcus') as { encrypted_payload: string } | undefined;
      if (phiRowMarcus) {
        try {
          const d = decryptPHI<{ insuranceProvider: string }>(phiRowMarcus.encrypted_payload);
          if (d.insuranceProvider === 'Aetna Caremark Plus') {
            db.prepare('UPDATE patients_phi SET encrypted_payload = ?, updated_at = ? WHERE user_id = ?').run(
              encryptPHI({
                dob: '1974-09-28',
                phone: '+233 50 609 4412',
                address: '28 Cantonments Crescent, Accra · GA-054-8821',
                allergies: ['No Known Drug Allergies'],
                insuranceProvider: 'Acacia Health Insurance',
                bin: '233002',
                pcn: 'ACACIA',
                groupNumber: 'ACA-55190',
                memberId: 'ACA-71029384',
              }),
              nowIso2,
              'usr_patient_marcus'
            );
          }
        } catch {
          // ignore
        }
      }
    }

    // Idempotent Ghana localization for previously seeded user & clinical/audit records
    const hasLegacyUsers = db
      .prepare(`SELECT 1 FROM users WHERE display_name IN ('Maya Lin', 'Marcus Reed', 'Dr. Elena Vance, PharmD', 'David Netanya, PharmD') LIMIT 1`)
      .get();
    if (hasLegacyUsers) {
      db.prepare(`UPDATE users SET display_name = 'Ama Serwaa Mensah' WHERE id = 'usr_patient_maya' AND display_name = 'Maya Lin'`).run();
      db.prepare(`UPDATE users SET display_name = 'Kwame Boateng' WHERE id = 'usr_patient_marcus' AND display_name = 'Marcus Reed'`).run();
      db.prepare(`UPDATE users SET display_name = 'Pharm. Akosua Osei, MPSGH' WHERE id = 'usr_pharm_elena' AND display_name = 'Dr. Elena Vance, PharmD'`).run();
      db.prepare(`UPDATE users SET display_name = 'Kofi Netanya, PharmD' WHERE id = 'usr_owner_david' AND display_name = 'David Netanya, PharmD'`).run();
    }

    const hasLegacyClinical = db
      .prepare(`SELECT 1 FROM prescriptions WHERE patient_name IN ('Maya Lin', 'Marcus Reed') LIMIT 1`)
      .get();
    if (hasLegacyClinical) {
      db.prepare(`UPDATE prescriptions SET patient_name = 'Ama Serwaa Mensah', prescriber_name = 'Dr. Abena Kuffour, MD' WHERE patient_id = 'usr_patient_maya'`).run();
      db.prepare(`UPDATE prescriptions SET patient_name = 'Kwame Boateng', prescriber_name = 'Dr. Kwame Mensah, MD' WHERE patient_id = 'usr_patient_marcus'`).run();
      db.prepare(`UPDATE care_plans SET patient_name = 'Ama Serwaa Mensah', pharmacist_name = 'Pharm. Akosua Osei, MPSGH' WHERE patient_id = 'usr_patient_maya'`).run();
      db.prepare(`UPDATE care_plans SET patient_name = 'Kwame Boateng', pharmacist_name = 'Pharm. Akosua Osei, MPSGH' WHERE patient_id = 'usr_patient_marcus'`).run();
      db.prepare(`UPDATE consultations SET patient_name = 'Ama Serwaa Mensah' WHERE patient_id = 'usr_patient_maya'`).run();
      db.prepare(`UPDATE consultation_messages SET sender_name = 'Ama Serwaa Mensah', body = 'Hi Pharm. Akosua, I noticed mild calf tightness after starting my Atorvastatin refill. Is it okay to take it with my morning Lisinopril instead of bedtime?' WHERE id = 'msg_1'`).run();
      db.prepare(`UPDATE consultation_messages SET sender_name = 'Pharm. Akosua Osei, MPSGH', body = 'Hi Ama — Atorvastatin has a long half-life so morning dosing works fine if easier to remember, though let us monitor that calf tightness closely. Stay hydrated and avoid grapefruit juice. Does the soreness improve with rest?' WHERE id = 'msg_2'`).run();
      db.prepare(`UPDATE otc_orders SET tax_cents = 851, total_cents = 6521 WHERE id = 'otc_102' AND tax_cents = 454`).run();
      db.prepare(`UPDATE audit_logs SET actor_name = 'Pharm. Akosua Osei, MPSGH' WHERE actor_id = 'usr_pharm_elena'`).run();
      db.prepare(`UPDATE audit_logs SET summary = 'Eliquis 5mg dropped below threshold (6/12); auto-generated PO-AUTO-3001 for Ernest & Tobinko MedSupply Ghana.' WHERE id = 'aud_2'`).run();
      db.prepare(`UPDATE audit_logs SET actor_name = 'Ama Serwaa Mensah', summary = 'Verified Ghana Data Protection Act 843, HIPAA & GDPR privacy consent and medication push alert consent.' WHERE id = 'aud_3'`).run();
    }
    migrateAndPopulateCatalogAndServices();
    return;
  }

  const now = new Date().toISOString();
  const inThreeDays = new Date(Date.now() + 1000 * 60 * 60 * 24 * 3).toISOString();
  const inTwoWeeks = new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString();
  const fiveDaysAgo = new Date(Date.now() - 1000 * 60 * 60 * 24 * 5).toISOString();
  const twoDaysAgo = new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toISOString();
  const yesterday = new Date(Date.now() - 1000 * 60 * 60 * 24 * 1).toISOString();

  // Seed Users
  const insertUser = db.prepare(`
    INSERT INTO users (id, email, password_hash, display_name, role, consent_accepted_at, marketing_opt_in, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertUser.run(
    'usr_patient_maya',
    'patient@netanyarx.com',
    hashPassword('PatientCare!2026'),
    'Ama Serwaa Mensah',
    'patient',
    now,
    1,
    now
  );
  insertUser.run(
    'usr_patient_marcus',
    'marcus.reed@netanyarx.com',
    hashPassword('PatientCare!2026'),
    'Kwame Boateng',
    'patient',
    now,
    0,
    now
  );
  insertUser.run(
    'usr_pharm_elena',
    'pharmacist@netanyarx.com',
    hashPassword('PharmStaff!2026'),
    'Pharm. Akosua Osei, MPSGH',
    'pharmacist',
    now,
    0,
    now
  );
  insertUser.run(
    'usr_supplier_apex',
    'supplier@netanyarx.com',
    hashPassword('SupplyChain!2026'),
    'Ernest & Tobinko MedSupply Ghana',
    'supplier',
    now,
    0,
    now
  );
  insertUser.run(
    'usr_owner_david',
    'owner@netanyarx.com',
    hashPassword('NetanyaOwner!2026'),
    'Kofi Netanya, PharmD',
    'owner',
    now,
    0,
    now
  );

  // Seed Encrypted Patient PHI
  const insertPhi = db.prepare(`
    INSERT INTO patients_phi (user_id, encrypted_payload, updated_at)
    VALUES (?, ?, ?)
  `);
  insertPhi.run(
    'usr_patient_maya',
    encryptPHI({
      dob: '1988-04-12',
      phone: '+233 24 418 8910',
      address: '14 Liberation Rd, East Legon, Accra · GA-312-4490',
      allergies: ['Penicillin (Rash)', 'Sulfa Drugs'],
      insuranceProvider: 'NHIS (National Health Insurance)',
      bin: '233001',
      pcn: 'NHISGH',
      groupNumber: 'NHIS-88420',
      memberId: 'GHA-NHIS-99412055',
    }),
    now
  );
  insertPhi.run(
    'usr_patient_marcus',
    encryptPHI({
      dob: '1974-09-28',
      phone: '+233 50 609 4412',
      address: '28 Cantonments Crescent, Accra · GA-054-8821',
      allergies: ['No Known Drug Allergies'],
      insuranceProvider: 'Acacia Health Insurance',
      bin: '233002',
      pcn: 'ACACIA',
      groupNumber: 'ACA-55190',
      memberId: 'ACA-71029384',
    }),
    now
  );

  // Seed Insurance Plans (Ghana Health Schemes)
  const insertPlan = db.prepare(`
    INSERT INTO insurance_plans (id, payer_name, bin, pcn, group_prefix, tier1_copay_cents, tier2_copay_cents, tier3_copay_cents, reimbursement_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertPlan.run('plan_bcbs', 'NHIS (National Health Insurance)', '233001', 'NHISGH', 'NHIS-', 500, 1500, 4500, 0.90);
  insertPlan.run('plan_aetna', 'Acacia Health Insurance', '233002', 'ACACIA', 'ACA-', 1000, 3000, 6500, 0.88);
  insertPlan.run('plan_uhc', 'Apex Health Insurance', '233003', 'APEXGH', 'APX-', 1200, 3500, 7500, 0.85);
  insertPlan.run('plan_cigna', 'Glico Healthcare', '233004', 'GLICO', 'GLC-', 1000, 3200, 7000, 0.86);

  // Seed Categorized Inventory + Pharmacy Services (shared helper for fresh & upgraded DBs)
  migrateAndPopulateCatalogAndServices();

  // Categorized items already inserted above via migrateAndPopulateCatalogAndServices()

  // Seed Prescriptions
  const insertRx = db.prepare(`
    INSERT INTO prescriptions (
      id, rx_number, patient_id, patient_name, inventory_id, medication_name, ndc_code,
      prescriber_name, dosage_instructions, quantity, days_supply, refills_remaining,
      next_refill_eligible_at, status, unit_price_cents, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertRx.run(
    'rx_1001',
    'RX-2026-8841',
    'usr_patient_maya',
    'Ama Serwaa Mensah',
    'inv_lisinopril',
    'Lisinopril 10mg Tablets (30ct)',
    '00093-1040-01',
    'Dr. Abena Kuffour, MD',
    'Take 1 tablet by mouth every morning with or without food.',
    30,
    30,
    3,
    inThreeDays,
    'dispensed',
    3400,
    fiveDaysAgo
  );
  insertRx.run(
    'rx_1002',
    'RX-2026-8842',
    'usr_patient_maya',
    'Ama Serwaa Mensah',
    'inv_atorvastatin',
    'Atorvastatin Calcium 20mg (30ct)',
    '00071-0156-23',
    'Dr. Abena Kuffour, MD',
    'Take 1 tablet by mouth once daily at bedtime.',
    30,
    30,
    2,
    inTwoWeeks,
    'ready',
    4600,
    yesterday
  );
  insertRx.run(
    'rx_1003',
    'RX-2026-8849',
    'usr_patient_marcus',
    'Kwame Boateng',
    'inv_eliquis',
    'Eliquis (Apixaban) 5mg Tablets (60ct)',
    '00003-0894-21',
    'Dr. Kwame Mensah, MD',
    'Take 1 tablet twice daily. Do not skip doses without physician direction.',
    60,
    30,
    4,
    now,
    'insurance_hold',
    58400,
    twoDaysAgo
  );
  insertRx.run(
    'rx_1004',
    'RX-2026-8854',
    'usr_patient_marcus',
    'Kwame Boateng',
    'inv_metformin',
    'Metformin HCl ER 500mg (60ct)',
    '00591-2411-01',
    'Dr. Kwame Mensah, MD',
    'Take 2 tablets once daily with evening meal.',
    60,
    30,
    5,
    inTwoWeeks,
    'verifying',
    2900,
    now
  );

  // Seed Care Plans
  const insertCare = db.prepare(`
    INSERT INTO care_plans (
      id, patient_id, patient_name, pharmacist_name, condition_focus,
      clinical_goals, interaction_warnings, adherence_notes, follow_up_date, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertCare.run(
    'cp_maya_1',
    'usr_patient_maya',
    'Ama Serwaa Mensah',
    'Pharm. Akosua Osei, MPSGH',
    'Hypertension & Lipid Optimization',
    'Maintain morning BP below 125/80 mmHg and LDL < 100 mg/dL via consistent evening statin timing.',
    'Avoid potassium-rich salt substitutes while on Lisinopril. Documented Penicillin allergy.',
    'Patient enrolled in morning & evening push reminders; 12-day adherence streak.',
    '2026-12-01',
    now
  );
  insertCare.run(
    'cp_marcus_1',
    'usr_patient_marcus',
    'Kwame Boateng',
    'Pharm. Akosua Osei, MPSGH',
    'Anticoagulation & Glycemic Control',
    'Ensure zero missed Apixaban doses and monitor A1C reduction on Metformin ER.',
    'Avoid NSAIDs (Ibuprofen/Naproxen) while taking Eliquis due to elevated bleeding risk.',
    'Prior authorization pending resolution for Tier 3 Eliquis claim.',
    '2026-11-24',
    now
  );

  // Seed Insurance Claims
  const insertClaim = db.prepare(`
    INSERT INTO insurance_claims (
      id, claim_number, prescription_id, rx_number, patient_id, patient_name,
      medication_name, payer_name, bin, pcn, group_id, formulary_tier, daw_code, days_supply,
      uc_price_cents, allowed_amount_cents, insurer_paid_cents, deductible_applied_cents,
      patient_copay_cents, rejection_code, rejection_message, override_code, override_notes,
      claim_status, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertClaim.run(
    'clm_1001',
    'CLM-99012',
    'rx_1001',
    'RX-2026-8841',
    'usr_patient_maya',
    'Ama Serwaa Mensah',
    'Lisinopril 10mg Tablets (30ct)',
    'NHIS (National Health Insurance)',
    '233001',
    'NHISGH',
    'NHIS-88420',
    1,
    '0',
    30,
    3400,
    2992,
    1992,
    0,
    1000,
    'none',
    'Claim adjudicated cleanly against payer benefit schedule.',
    '',
    '',
    'paid',
    fiveDaysAgo
  );
  insertClaim.run(
    'clm_1002',
    'CLM-99015',
    'rx_1002',
    'RX-2026-8842',
    'usr_patient_maya',
    'Ama Serwaa Mensah',
    'Atorvastatin Calcium 20mg (30ct)',
    'NHIS (National Health Insurance)',
    '233001',
    'NHISGH',
    'NHIS-88420',
    1,
    '0',
    30,
    4600,
    4048,
    3048,
    0,
    1000,
    'none',
    'Claim adjudicated cleanly against payer benefit schedule.',
    '',
    '',
    'adjudicated',
    yesterday
  );
  insertClaim.run(
    'clm_1003',
    'CLM-99019',
    'rx_1003',
    'RX-2026-8849',
    'usr_patient_marcus',
    'Kwame Boateng',
    'Eliquis (Apixaban) 5mg Tablets (60ct)',
    'Acacia Health Insurance',
    '233002',
    'ACACIA',
    'ACA-55190',
    3,
    '0',
    30,
    58400,
    49640,
    0,
    0,
    58400,
    '75',
    'Prior Authorization Required: Tier 3 / Specialty medication requires an active Prior Authorization number (prefix PA-) from the prescriber.',
    '',
    '',
    'rejected',
    twoDaysAgo
  );

  // Seed Replenishment Orders (auto-triggered for low stock items)
  const insertPo = db.prepare(`
    INSERT INTO replenishment_orders (
      id, po_number, inventory_id, medication_name, ndc_code,
      supplier_id, supplier_name, requested_qty, confirmed_qty,
      batch_number, batch_expiry, scheduled_delivery_date, delivery_window,
      status, auto_triggered, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertPo.run(
    'po_3001',
    'PO-AUTO-3001',
    'inv_eliquis',
    'Eliquis (Apixaban) 5mg Tablets (60ct)',
    '00003-0894-21',
    'usr_supplier_apex',
    'Ernest & Tobinko MedSupply Ghana',
    30,
    null,
    null,
    null,
    null,
    null,
    'awaiting_supplier',
    1,
    yesterday,
    yesterday
  );
  insertPo.run(
    'po_3002',
    'PO-AUTO-3002',
    'inv_metformin',
    'Metformin HCl ER 500mg (60ct)',
    '00591-2411-01',
    'usr_supplier_apex',
    'Ernest & Tobinko MedSupply Ghana',
    80,
    80,
    'LOT-MET-9904',
    '2028-10-31',
    '2026-11-18',
    '09:00 - 11:30',
    'confirmed_scheduled',
    1,
    twoDaysAgo,
    yesterday
  );

  // Seed Medication Reminders
  const insertRem = db.prepare(`
    INSERT INTO medication_reminders (
      id, patient_id, medication_name, dosage_label, time_of_day, frequency, push_enabled, last_taken_date, adherence_streak
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertRem.run(
    'rem_1',
    'usr_patient_maya',
    'Lisinopril 10mg',
    '1 tablet · Morning with water',
    '08:00',
    'Daily',
    1,
    yesterday.slice(0, 10),
    12
  );
  insertRem.run(
    'rem_2',
    'usr_patient_maya',
    'Atorvastatin 20mg',
    '1 tablet · Bedtime',
    '21:00',
    'Daily',
    1,
    yesterday.slice(0, 10),
    12
  );
  insertRem.run(
    'rem_3',
    'usr_patient_maya',
    'Vitality D3 + K2',
    '1 capsule · With breakfast',
    '08:30',
    'Daily',
    1,
    null,
    6
  );

  // Seed Consultations
  db.prepare(`
    INSERT INTO consultations (id, patient_id, patient_name, subject, status, last_message_at, unread_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'con_maya_1',
    'usr_patient_maya',
    'Ama Serwaa Mensah',
    'Atorvastatin timing & mild muscle ache question',
    'open',
    yesterday,
    1
  );

  const insertMsg = db.prepare(`
    INSERT INTO consultation_messages (id, thread_id, sender_id, sender_name, sender_role, body, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertMsg.run(
    'msg_1',
    'con_maya_1',
    'usr_patient_maya',
    'Ama Serwaa Mensah',
    'patient',
    'Hi Pharm. Akosua, I noticed mild calf tightness after starting my Atorvastatin refill. Is it okay to take it with my morning Lisinopril instead of bedtime?',
    twoDaysAgo
  );
  insertMsg.run(
    'msg_2',
    'con_maya_1',
    'usr_pharm_elena',
    'Pharm. Akosua Osei, MPSGH',
    'pharmacist',
    'Hi Ama — Atorvastatin has a long half-life so morning dosing works fine if easier to remember, though let us monitor that calf tightness closely. Stay hydrated and avoid grapefruit juice. Does the soreness improve with rest?',
    yesterday
  );

  // Seed Historical OTC Orders for Analytics
  const insertOtc = db.prepare(`
    INSERT INTO otc_orders (
      id, order_number, customer_name, customer_email, fulfillment_type, shipping_address,
      items_json, subtotal_cents, tax_cents, total_cents, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertOtc.run(
    'otc_101',
    'ORD-77101',
    'Ama Serwaa Mensah',
    'patient@netanyarx.com',
    'pickup',
    'In-Store Pickup · Netanya Pharmacy Desk, Accra',
    JSON.stringify([
      {
        inventoryId: 'inv_bpmon',
        name: 'Clinical Upper-Arm Digital BP Monitor',
        quantity: 1,
        unitPriceCents: 6800,
      },
      {
        inventoryId: 'inv_vitd3',
        name: 'Vitality D3 + K2 Clinical Complex (60ct)',
        quantity: 2,
        unitPriceCents: 2495,
      },
    ]),
    11790,
    1769,
    13559,
    'ready_for_pickup',
    twoDaysAgo
  );
  insertOtc.run(
    'otc_102',
    'ORD-77102',
    'Kojo Appiah',
    'k.appiah@example.com',
    'delivery',
    '19 Osu Oxford St, Accra · GA-054-1102',
    JSON.stringify([
      {
        inventoryId: 'inv_hydro',
        name: 'Hydrate.Clinical Electrolyte Sachets (12-Pack)',
        quantity: 3,
        unitPriceCents: 1890,
      },
    ]),
    5670,
    851,
    6521,
    'dispatched',
    yesterday
  );

  // Seed Audit Logs
  const insertAudit = db.prepare(`
    INSERT INTO audit_logs (id, actor_id, actor_name, actor_role, action, resource_type, resource_id, summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertAudit.run(
    'aud_1',
    'usr_pharm_elena',
    'Pharm. Akosua Osei, MPSGH',
    'pharmacist',
    'CLAIM_SUBMITTED',
    'insurance_claims',
    'clm_1003',
    'Submitted Eliquis claim CLM-99019; payer returned NCPDP 75 (Prior Auth Required).',
    twoDaysAgo
  );
  insertAudit.run(
    'aud_2',
    'usr_pharm_elena',
    'Pharm. Akosua Osei, MPSGH',
    'pharmacist',
    'AUTO_REPLENISHMENT_TRIGGERED',
    'replenishment_orders',
    'po_3001',
    'Eliquis 5mg dropped below threshold (6/12); auto-generated PO-AUTO-3001 for Ernest & Tobinko MedSupply Ghana.',
    yesterday
  );
  insertAudit.run(
    'aud_3',
    'usr_patient_maya',
    'Ama Serwaa Mensah',
    'patient',
    'GDPR_CONSENT_RECORDED',
    'users',
    'usr_patient_maya',
    'Verified Ghana Data Protection Act 843, HIPAA & GDPR privacy consent and medication push alert consent.',
    now
  );
}

function migrateAndPopulateCatalogAndServices(): void {
  // 1. Migrate legacy 3-bucket categories on previously seeded items
  const legacyCategoryUpdates: Array<[string, string]> = [
    ['inv_vitd3', 'Vitamins & Wellness'],
    ['inv_bpmon', 'Devices & First Aid'],
    ['inv_ibu', 'Pain & Fever'],
    ['inv_hydro', 'Digestive & Stomach'],
    ['inv_lisinopril', 'Chronic & Heart'],
    ['inv_atorvastatin', 'Chronic & Heart'],
    ['inv_eliquis', 'Chronic & Heart'],
    ['inv_metformin', 'Chronic & Heart'],
  ];
  const updateLegacyCat = db.prepare(
    `UPDATE inventory SET category = ? WHERE id = ? AND category IN ('Rx', 'OTC', 'Wellness')`
  );
  for (const [id, newCat] of legacyCategoryUpdates) {
    updateLegacyCat.run(newCat, id);
  }
  // Fallback for any staff-created legacy items
  db.prepare(`UPDATE inventory SET category = 'Chronic & Heart' WHERE category = 'Rx'`).run();
  db.prepare(`UPDATE inventory SET category = 'Pain & Fever' WHERE category = 'OTC'`).run();
  db.prepare(`UPDATE inventory SET category = 'Vitamins & Wellness' WHERE category = 'Wellness'`).run();

  // 2. Populate & enrich Ghanaian pharmacy items across all 7 categories with official manufacturer info & pictures
  interface SeedCatalogItem {
    id: string;
    ndcCode: string;
    name: string;
    category: string;
    description: string;
    imageUrl: string;
    manufacturerName: string;
    activeIngredient: string;
    dosageForm: string;
    usageDirections: string;
    warnings: string;
    storageInfo: string;
    officialSourceUrl: string;
    unitPriceCents: number;
    costPriceCents: number;
    stockQuantity: number;
    reorderThreshold: number;
    reorderQuantity: number;
    lotNumber: string;
    expiryDate: string;
    requiresPrescription: number;
  }

  const catalogItems: SeedCatalogItem[] = [
    // Pain & Fever
    {
      id: 'inv_paracetamol',
      ndcCode: 'GHA-PF-500-30',
      name: 'Panadol Advance Paracetamol 500mg (30ct)',
      category: 'Pain & Fever',
      description: 'Fast-release Optizorb paracetamol tablets for headache, body aches, toothache, and fever.',
      imageUrl: '/drug-images/inv_paracetamol.png',
      manufacturerName: 'Haleon (Panadol)',
      activeIngredient: 'Paracetamol (Acetaminophen) 500 mg per tablet',
      dosageForm: 'Film-coated tablets · Box of 30',
      usageDirections: 'Adults and children 12+ years: Take 1 to 2 tablets every 4 to 6 hours with water as needed. Do not take more than 8 tablets (4,000 mg) in 24 hours.',
      warnings: 'Contains paracetamol. Do not take with any other paracetamol-containing medicines. Taking more than the recommended dose can cause serious liver damage. Consult a doctor if fever lasts over 3 days.',
      storageInfo: 'Store in a dry place below 25°C. Keep out of reach of children.',
      officialSourceUrl: 'https://www.panadol.com/en-gb/adult-products/panadol-advance-optizorb-tablets/',
      unitPriceCents: 1200,
      costPriceCents: 520,
      stockQuantity: 120,
      reorderThreshold: 30,
      reorderQuantity: 100,
      lotNumber: 'LOT-PCM-26A',
      expiryDate: '2028-08-31',
      requiresPrescription: 0,
    },
    {
      id: 'inv_ibu',
      ndcCode: '00573-0169-24',
      name: 'Advil Ibuprofen 200mg Coated Tablets (24ct)',
      category: 'Pain & Fever',
      description: 'NSAID pain reliever and fever reducer for headaches, muscle aches, joint pain, and menstrual cramps.',
      imageUrl: '/drug-images/inv_ibu.jpg',
      manufacturerName: 'Haleon US Holdings LLC',
      activeIngredient: 'Ibuprofen 200 mg (NSAID) per coated tablet',
      dosageForm: 'Coated tablets · Bottle / Carton of 24',
      usageDirections: 'Adults and children 12+ years: Take 1 tablet every 4 to 6 hours while symptoms persist. If pain or fever does not respond to 1 tablet, 2 tablets may be used. Do not exceed 6 tablets in 24 hours.',
      warnings: 'Stomach bleeding warning: May cause severe stomach bleeding especially in patients over 60, those with ulcers, or those taking blood thinners or steroids. Take with food or milk if stomach upset occurs.',
      storageInfo: 'Store at 20°C to 25°C (68°F to 77°F). Avoid excessive heat above 40°C.',
      officialSourceUrl: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=1a665e64-9f30-be37-4a83-38789f1f1e89',
      unitPriceCents: 1450,
      costPriceCents: 600,
      stockQuantity: 74,
      reorderThreshold: 25,
      reorderQuantity: 60,
      lotNumber: 'LOT-IBU-26K',
      expiryDate: '2028-02-28',
      requiresPrescription: 0,
    },
    {
      id: 'inv_diclofenac_gel',
      ndcCode: '00067-7905-50',
      name: 'Voltaren Emulgel Diclofenac Sodium 1% (50g)',
      category: 'Pain & Fever',
      description: 'Topical NSAID anti-inflammatory gel for arthritis joint pain, sprains, strains, and waist or back ache.',
      imageUrl: '/drug-images/inv_diclofenac_gel.jpg',
      manufacturerName: 'Haleon (Voltaren)',
      activeIngredient: 'Diclofenac sodium 1% w/w (equivalent to 1.16% diclofenac diethylammonium)',
      dosageForm: 'Topical Emulgel · 50 g tube',
      usageDirections: 'Apply 2 g to 4 g gently onto the affected joint or muscle 3 to 4 times daily. Wash hands after applying unless treating hands. Wait 1 hour before showering.',
      warnings: 'For external use only. Do not apply to open wounds, eyes, or broken skin. Stop use and seek care if skin rash develops. Do not use in the last 3 months of pregnancy.',
      storageInfo: 'Store at 20°C to 25°C. Do not freeze.',
      officialSourceUrl: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=30a94282-0892-442a-aa10-6525cbd4fe88',
      unitPriceCents: 2600,
      costPriceCents: 1150,
      stockQuantity: 36,
      reorderThreshold: 10,
      reorderQuantity: 30,
      lotNumber: 'LOT-DCG-26B',
      expiryDate: '2028-05-15',
      requiresPrescription: 0,
    },

    // Malaria & Infections
    {
      id: 'inv_lonart_ds',
      ndcCode: '00078-0568-45',
      name: 'Coartem / Lonart DS Artemether-Lumefantrine 80/480mg (6ct)',
      category: 'Malaria & Infections',
      description: 'Standard 3-day fixed-dose ACT antimalarial therapy for acute, uncomplicated Plasmodium falciparum malaria.',
      imageUrl: '/drug-images/inv_lonart_ds.jpg',
      manufacturerName: 'Novartis Pharmaceuticals / Bliss GVS Pharma',
      activeIngredient: 'Artemether 80 mg + Lumefantrine 480 mg (DS) / 20 mg + 120 mg standard tablets',
      dosageForm: 'Film-coated tablets · Full 3-day malaria course',
      usageDirections: 'Take 1 adult DS tablet twice daily for 3 consecutive days (6 doses total: 0h, 8h, 24h, 36h, 48h, 60h). Always take with food or a milky drink so the medicine absorbs properly.',
      warnings: 'Complete the full 3-day course even if fever settles early. Avoid in patients with known heart rhythm (QT) prolongation or low potassium. Consult a pharmacist during first trimester of pregnancy.',
      storageInfo: 'Store below 30°C in original blister pack protected from light and moisture.',
      officialSourceUrl: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=7866ec19-dfac-47d4-a53f-511a12643cbf',
      unitPriceCents: 3800,
      costPriceCents: 1950,
      stockQuantity: 64,
      reorderThreshold: 20,
      reorderQuantity: 50,
      lotNumber: 'LOT-LON-26D',
      expiryDate: '2028-04-30',
      requiresPrescription: 0,
    },
    {
      id: 'inv_amoxicillin',
      ndcCode: '67296-0521-21',
      name: 'Amoxicillin 500mg Capsules (21ct)',
      category: 'Malaria & Infections',
      description: 'Penicillin-class broad-spectrum antibiotic for chest, ear, sinus, dental, throat, and urinary infections.',
      imageUrl: '/drug-images/inv_amoxicillin.jpg',
      manufacturerName: 'Redpharm / Sandoz Pharmaceuticals',
      activeIngredient: 'Amoxicillin trihydrate equivalent to 500 mg Amoxicillin',
      dosageForm: 'Hard gelatin capsules · 21 capsules',
      usageDirections: 'Typical adult dose: Take 1 capsule (500 mg) every 8 hours for 7 days, or as directed by your prescriber. Can be taken with or without food.',
      warnings: 'Do not take if allergic to penicillin or cephalosporin antibiotics. Seek emergency care immediately for severe rash, wheezing, or facial swelling. Finish all prescribed capsules.',
      storageInfo: 'Store at controlled room temperature 20°C to 25°C in a tight container.',
      officialSourceUrl: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=5f988a71-c189-7200-e063-6294a90a0f37',
      unitPriceCents: 2800,
      costPriceCents: 1100,
      stockQuantity: 85,
      reorderThreshold: 25,
      reorderQuantity: 60,
      lotNumber: 'LOT-AMX-26E',
      expiryDate: '2028-01-31',
      requiresPrescription: 1,
    },
    {
      id: 'inv_azithromycin',
      ndcCode: '00069-3070-75',
      name: 'Zithromax Azithromycin 500mg Tri-Pak (3 Tablets)',
      category: 'Malaria & Infections',
      description: 'Macrolide antibiotic 3-day pack for respiratory tract, throat, ear, and soft tissue bacterial infections.',
      imageUrl: '/drug-images/inv_azithromycin.jpg',
      manufacturerName: 'Pfizer Laboratories',
      activeIngredient: 'Azithromycin dihydrate equivalent to 500 mg Azithromycin',
      dosageForm: 'Film-coated tablets · 3-tablet Tri-Pak',
      usageDirections: 'Typical adult regimen: Take 1 tablet (500 mg) once daily for 3 consecutive days, with or without food.',
      warnings: 'May cause rare liver toxicity or irregular heart rhythm (QT prolongation). Stop use and seek care if yellowing of eyes/skin or severe diarrhea occurs. Avoid taking at the exact same time as aluminum/magnesium antacids.',
      storageInfo: 'Store between 15°C and 30°C in dry original blister.',
      officialSourceUrl: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=db52b91e-79f7-4cc1-9564-f2eee8e31c45',
      unitPriceCents: 4200,
      costPriceCents: 1800,
      stockQuantity: 42,
      reorderThreshold: 15,
      reorderQuantity: 40,
      lotNumber: 'LOT-AZM-26F',
      expiryDate: '2028-07-31',
      requiresPrescription: 1,
    },
    {
      id: 'inv_cipro',
      ndcCode: '43063-0617-10',
      name: 'Ciprofloxacin 500mg Film-Coated Tablets (10ct)',
      category: 'Malaria & Infections',
      description: 'Fluoroquinolone antibiotic prescribed for urinary tract infections (UTI), typhoid fever, and bacterial gut infections.',
      imageUrl: '/drug-images/inv_cipro.jpg',
      manufacturerName: 'Hikma / PD-Rx Pharmaceuticals',
      activeIngredient: 'Ciprofloxacin hydrochloride equivalent to 500 mg Ciprofloxacin',
      dosageForm: 'Film-coated tablets · 10 tablets',
      usageDirections: 'Typical adult dose: Take 1 tablet (500 mg) every 12 hours with a full glass of water. Take at least 2 hours before or 6 hours after dairy products, calcium, iron, or antacids.',
      warnings: 'Fluoroquinolone boxed warning: Stop taking and notify a doctor if tendon pain/swelling, numbness/tingling, or dizziness occurs. Avoid direct excessive sunlight and stay well hydrated.',
      storageInfo: 'Store below 30°C in a tight, light-resistant container.',
      officialSourceUrl: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=5723eaf9-8659-4730-b792-4e4c33690ccb',
      unitPriceCents: 3200,
      costPriceCents: 1350,
      stockQuantity: 52,
      reorderThreshold: 15,
      reorderQuantity: 45,
      lotNumber: 'LOT-CIP-26G',
      expiryDate: '2028-03-31',
      requiresPrescription: 1,
    },

    // Chronic & Heart
    {
      id: 'inv_lisinopril',
      ndcCode: '42708-031-30',
      name: 'Lisinopril 10mg Tablets (30ct)',
      category: 'Chronic & Heart',
      description: 'Once-daily ACE inhibitor for high blood pressure (hypertension), heart failure, and kidney protection.',
      imageUrl: '/drug-images/inv_lisinopril.jpg',
      manufacturerName: 'QPharma / AstraZeneca Standard',
      activeIngredient: 'Lisinopril USP 10 mg per tablet',
      dosageForm: 'Oral tablets · 30 tablets',
      usageDirections: 'Take once daily at the same time each morning, with or without food, exactly as prescribed.',
      warnings: 'Pregnancy warning: Discontinue immediately if pregnancy occurs as ACE inhibitors can harm an unborn baby. Report persistent dry cough, dizziness, or swelling of lips/tongue immediately.',
      storageInfo: 'Store at 20°C to 25°C. Protect from moisture.',
      officialSourceUrl: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=b17cd16b-8d0a-4cfa-bd48-2529983fcd12',
      unitPriceCents: 3400,
      costPriceCents: 950,
      stockQuantity: 140,
      reorderThreshold: 40,
      reorderQuantity: 120,
      lotNumber: 'LOT-LIS-8841',
      expiryDate: '2027-09-30',
      requiresPrescription: 1,
    },
    {
      id: 'inv_amlodipine',
      ndcCode: '58151-354-77',
      name: 'Norvasc Amlodipine Besylate 5mg Tablets (30ct)',
      category: 'Chronic & Heart',
      description: 'Calcium channel blocker for steady daily blood pressure control and chest pain (angina) prevention.',
      imageUrl: '/drug-images/inv_amlodipine.jpg',
      manufacturerName: 'Viatris Specialty LLC (Pfizer Originator)',
      activeIngredient: 'Amlodipine besylate equivalent to 5 mg Amlodipine',
      dosageForm: 'Oral tablets · Bottle / Blister of 30',
      usageDirections: 'Adult recommended starting dose: 5 mg taken orally once daily, with or without food. Maximum usual dose is 10 mg once daily.',
      warnings: 'May cause mild ankle swelling, flushing, or dizziness when standing up quickly. Do not stop taking blood pressure tablets suddenly without speaking to your prescriber.',
      storageInfo: 'Store at 15°C to 30°C in tight, light-resistant container.',
      officialSourceUrl: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=7367289c-b0b0-466a-83e2-558e2985c29f',
      unitPriceCents: 2400,
      costPriceCents: 800,
      stockQuantity: 95,
      reorderThreshold: 25,
      reorderQuantity: 80,
      lotNumber: 'LOT-AML-26H',
      expiryDate: '2028-09-30',
      requiresPrescription: 1,
    },
    {
      id: 'inv_atorvastatin',
      ndcCode: '58151-156-77',
      name: 'Lipitor Atorvastatin Calcium 20mg Tablets (30ct)',
      category: 'Chronic & Heart',
      description: 'Statin medication to lower LDL cholesterol and reduce the risk of stroke and heart attack.',
      imageUrl: '/drug-images/inv_atorvastatin.jpg',
      manufacturerName: 'Viatris Specialty LLC (Pfizer Originator)',
      activeIngredient: 'Atorvastatin calcium equivalent to 20 mg Atorvastatin',
      dosageForm: 'Film-coated tablets · 30 tablets',
      usageDirections: 'Take 1 tablet orally once daily at any time of day, with or without food, alongside a heart-healthy diet.',
      warnings: 'Notify your doctor promptly if you notice unexplained muscle pain, tenderness, or dark urine. Avoid large quantities of grapefruit juice. Not recommended during pregnancy or breastfeeding.',
      storageInfo: 'Store at controlled room temperature 20°C to 25°C.',
      officialSourceUrl: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=a60cc18b-0631-4cf0-b021-9f52224ece65',
      unitPriceCents: 4600,
      costPriceCents: 1400,
      stockQuantity: 92,
      reorderThreshold: 30,
      reorderQuantity: 90,
      lotNumber: 'LOT-ATV-4192',
      expiryDate: '2028-03-15',
      requiresPrescription: 1,
    },
    {
      id: 'inv_eliquis',
      ndcCode: '00003-0894-21',
      name: 'Eliquis Apixaban 5mg Tablets (60ct)',
      category: 'Chronic & Heart',
      description: 'Factor Xa blood thinner to prevent stroke in atrial fibrillation and treat DVT/PE blood clots.',
      imageUrl: '/drug-images/inv_eliquis.jpg',
      manufacturerName: 'Bristol Myers Squibb & Pfizer',
      activeIngredient: 'Apixaban 5 mg per film-coated tablet',
      dosageForm: 'Film-coated tablets · 60 tablets',
      usageDirections: 'Standard adult dose: Take 5 mg orally twice daily (morning and evening), with or without food. Needs scheme PA- code if billed to insurance.',
      warnings: 'Boxed warning: Do not stop taking Eliquis without talking to your doctor—stopping early increases blood clot and stroke risk. Increases bleeding risk; report unusual bruising, dark stools, or pink urine right away.',
      storageInfo: 'Store at 20°C to 25°C (68°F to 77°F) in original container.',
      officialSourceUrl: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=e9481622-7cc6-418a-acb6-c5450daae9b0',
      unitPriceCents: 58400,
      costPriceCents: 43800,
      stockQuantity: 6,
      reorderThreshold: 12,
      reorderQuantity: 30,
      lotNumber: 'LOT-ELQ-1093',
      expiryDate: '2027-07-01',
      requiresPrescription: 1,
    },
    {
      id: 'inv_metformin',
      ndcCode: '43063-0620-60',
      name: 'Metformin HCl Extended-Release 500mg (60ct)',
      category: 'Chronic & Heart',
      description: 'First-line extended-release tablet to control blood sugar in adults with Type 2 diabetes.',
      imageUrl: '/drug-images/inv_metformin.jpg',
      manufacturerName: 'Merck / PD-Rx Pharmaceuticals',
      activeIngredient: 'Metformin hydrochloride 500 mg (Extended Release)',
      dosageForm: 'Extended-release tablets · 60 tablets',
      usageDirections: 'Swallow tablets whole with an evening meal—never crush, cut, or chew. Usual starting dose is 500 mg once daily with dinner.',
      warnings: 'Boxed warning: Rare risk of lactic acidosis, especially in severe kidney disease, dehydration, or heavy alcohol use. Inform imaging staff before CT contrast scans.',
      storageInfo: 'Store at 20°C to 25°C in a tight, light-resistant container.',
      officialSourceUrl: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=14f3091c-f243-4364-b433-727c7d4ef8d5',
      unitPriceCents: 2900,
      costPriceCents: 820,
      stockQuantity: 11,
      reorderThreshold: 20,
      reorderQuantity: 80,
      lotNumber: 'LOT-MET-5520',
      expiryDate: '2027-12-20',
      requiresPrescription: 1,
    },

    // Cough, Cold & Allergy
    {
      id: 'inv_cetirizine',
      ndcCode: '50580-726-14',
      name: 'Zyrtec Cetirizine HCl 10mg Allergy Tabs (14ct)',
      category: 'Cough, Cold & Allergy',
      description: '24-hour antihistamine relief for sneezing, runny nose, itchy watery eyes, catarrh, and skin hives.',
      imageUrl: '/drug-images/inv_cetirizine.jpg',
      manufacturerName: 'Kenvue (Johnson & Johnson Consumer)',
      activeIngredient: 'Cetirizine hydrochloride 10 mg per tablet/capsule',
      dosageForm: 'Oral 10 mg tablets · Blister pack of 14',
      usageDirections: 'Adults and children 6+ years: Take one 10 mg tablet once daily. Do not take more than one 10 mg dose in 24 hours.',
      warnings: 'Drowsiness may occur in some people—use caution when driving or operating machinery. Ask a doctor before use if you have liver or kidney disease.',
      storageInfo: 'Store between 20°C and 25°C.',
      officialSourceUrl: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=59cef432-41ac-768c-e063-6294a90a38fa',
      unitPriceCents: 1600,
      costPriceCents: 600,
      stockQuantity: 68,
      reorderThreshold: 20,
      reorderQuantity: 60,
      lotNumber: 'LOT-CET-26J',
      expiryDate: '2028-10-31',
      requiresPrescription: 0,
    },
    {
      id: 'inv_ambroxol',
      ndcCode: 'GHA-CCA-100-01',
      name: 'Mucosolvan Ambroxol 30mg/5mL Cough Syrup (100ml)',
      category: 'Cough, Cold & Allergy',
      description: 'Sanofi mucolytic syrup that thins thick chest phlegm and clears wet or stubborn coughs.',
      imageUrl: '/drug-images/inv_ambroxol.jpg',
      manufacturerName: 'Sanofi Consumer Healthcare',
      activeIngredient: 'Ambroxol hydrochloride 30 mg per 5 mL oral liquid',
      dosageForm: 'Oral liquid syrup · 100 mL bottle + measuring cup',
      usageDirections: 'Adults & children 12+ years: 5 mL three times daily for the first 2–3 days, then 5 mL twice daily. Children 6–12 years: 2.5 mL three times daily.',
      warnings: 'Do not give to children under 2 years without medical direction. Stop immediately and seek care if a new skin rash or mouth/eye blisters appear. Consult a doctor in severe kidney or liver disease.',
      storageInfo: 'Store below 30°C away from direct sunlight.',
      officialSourceUrl: 'https://www.mucosolvan.my/products',
      unitPriceCents: 3200,
      costPriceCents: 1450,
      stockQuantity: 38,
      reorderThreshold: 12,
      reorderQuantity: 36,
      lotNumber: 'LOT-AMB-26L',
      expiryDate: '2028-04-15',
      requiresPrescription: 0,
    },
    {
      id: 'inv_lozenges',
      ndcCode: 'GHA-CCA-024-01',
      name: 'Strepsils Honey & Lemon Throat Lozenges (24ct)',
      category: 'Cough, Cold & Allergy',
      description: 'Dual-antiseptic soothing lozenges for sore throat, dry cough irritation, and mouth/throat infection relief.',
      imageUrl: '/drug-images/inv_lozenges.webp',
      manufacturerName: 'Reckitt Benckiser Healthcare',
      activeIngredient: '2,4-Dichlorobenzyl alcohol 1.2 mg + Amylmetacresol 0.6 mg',
      dosageForm: 'Medicated lozenges · Pack of 24',
      usageDirections: 'Adults and children over 6 years: Dissolve 1 lozenge slowly in the mouth every 2 to 3 hours as required. Maximum 12 lozenges in 24 hours.',
      warnings: 'Not suitable for children under 6 years (choking risk). Contains sucrose and glucose. Consult a doctor if sore throat lasts more than 3 days or comes with high fever.',
      storageInfo: 'Store below 25°C in a dry place.',
      officialSourceUrl: 'https://www.strepsils.co.uk/all-products/strepsils-honey-lemon-lozenges/',
      unitPriceCents: 1800,
      costPriceCents: 750,
      stockQuantity: 54,
      reorderThreshold: 15,
      reorderQuantity: 48,
      lotNumber: 'LOT-LOZ-26N',
      expiryDate: '2028-11-30',
      requiresPrescription: 0,
    },

    // Digestive & Stomach
    {
      id: 'inv_hydro',
      ndcCode: '00721-9040-12',
      name: 'Dioralyte Oral Rehydration Salts (ORS 12-Pack)',
      category: 'Digestive & Stomach',
      description: 'Fast fluid and electrolyte replacement sachets for dehydration from diarrhea, vomiting, fever, or heat.',
      imageUrl: '/drug-images/inv_hydro.png',
      manufacturerName: 'Phoenix Labs / Sanofi Standard',
      activeIngredient: 'Sodium chloride, Potassium chloride, Disodium hydrogen citrate & Glucose',
      dosageForm: 'Oral rehydration powder · 12 sachets',
      usageDirections: 'Dissolve 1 sachet completely in 200 mL of clean drinking water (freshly boiled & cooled for infants). Sip after each loose stool. Discard unused solution after 1 hour (or 24h refrigerated).',
      warnings: 'Do not dissolve in anything other than plain drinking water and do not boil the mixed solution. Seek medical attention if diarrhea lasts over 24–48 hours or in infants under 1 year.',
      storageInfo: 'Store unopened sachets in a cool, dry place below 25°C.',
      officialSourceUrl: 'https://dioralyte.co.uk/',
      unitPriceCents: 2100,
      costPriceCents: 900,
      stockQuantity: 32,
      reorderThreshold: 15,
      reorderQuantity: 45,
      lotNumber: 'LOT-HYD-26M',
      expiryDate: '2027-11-30',
      requiresPrescription: 0,
    },
    {
      id: 'inv_omeprazole',
      ndcCode: '37000-452-14',
      name: 'Prilosec OTC Omeprazole 20mg Delayed-Release (14ct)',
      category: 'Digestive & Stomach',
      description: 'Once-daily acid blocker (PPI) for frequent heartburn, acid reflux (GERD), and stomach ulcer relief.',
      imageUrl: '/drug-images/inv_omeprazole.jpg',
      manufacturerName: 'Procter & Gamble / AstraZeneca Originator',
      activeIngredient: 'Omeprazole magnesium 20.6 mg (equivalent to 20 mg Omeprazole)',
      dosageForm: 'Delayed-release tablets · 14-day course',
      usageDirections: 'Adults 18+ years: Swallow 1 tablet whole with water once daily before breakfast for 14 days. Do not crush or chew tablets.',
      warnings: 'Not for immediate instant heartburn relief (full effect takes 1–4 days). Seek a doctor before use if you have trouble swallowing food, vomiting blood, black stools, or heartburn lasting over 3 months.',
      storageInfo: 'Store at 20°C to 25°C and protect from moisture.',
      officialSourceUrl: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=37291cab-e350-d8e3-e063-6294a90a9cb1',
      unitPriceCents: 2200,
      costPriceCents: 900,
      stockQuantity: 76,
      reorderThreshold: 20,
      reorderQuantity: 60,
      lotNumber: 'LOT-OMP-26P',
      expiryDate: '2028-06-30',
      requiresPrescription: 0,
    },
    {
      id: 'inv_albendazole',
      ndcCode: '65162-537-02',
      name: 'Albenza / Zentel Albendazole 400mg Dewormer (2ct)',
      category: 'Digestive & Stomach',
      description: 'Single-dose broad-spectrum anthelmintic tablet to clear common intestinal worms (roundworm, hookworm, pinworm).',
      imageUrl: '/drug-images/inv_albendazole.jpg',
      manufacturerName: 'GSK / Amneal Pharmaceuticals',
      activeIngredient: 'Albendazole 400 mg (two 200 mg film-coated tablets)',
      dosageForm: 'Film-coated tablets · 400 mg full adult dose',
      usageDirections: 'Adults and children over 2 years: Take 400 mg as a single dose for common intestinal worms. Tablets may be swallowed with water, chewed, or crushed.',
      warnings: 'Pregnancy warning: Do NOT take if pregnant or suspecting pregnancy. Women of childbearing age should start treatment only after a negative pregnancy test or during the first week of menses.',
      storageInfo: 'Store at 20°C to 25°C in a dry place.',
      officialSourceUrl: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=62a3f663-9e76-47f6-b089-54e4db01f697',
      unitPriceCents: 1500,
      costPriceCents: 580,
      stockQuantity: 90,
      reorderThreshold: 25,
      reorderQuantity: 70,
      lotNumber: 'LOT-ALB-26Q',
      expiryDate: '2028-09-15',
      requiresPrescription: 0,
    },

    // Vitamins & Wellness
    {
      id: 'inv_vitd3',
      ndcCode: '5021265-2045',
      name: 'Vitabiotics Ultra Vitamin D 1000IU (96 Tablets)',
      category: 'Vitamins & Wellness',
      description: 'UK pharmacopoeia grade Vitamin D3 tablets supporting immune function, strong bones, teeth, and muscle health.',
      imageUrl: '/drug-images/inv_vitd3.png',
      manufacturerName: 'Vitabiotics Ltd (UK)',
      activeIngredient: 'Vitamin D3 (Cholecalciferol) 25 µg (1000 IU) per tablet',
      dosageForm: 'Micro-tablets · Box of 96',
      usageDirections: 'Take 1 tablet daily with your main meal and swallow with water or a cold drink. Do not chew.',
      warnings: 'Do not exceed the recommended daily intake. Seek medical advice before use if under medical supervision, pregnant, breastfeeding, or suffering from hypercalcemia or kidney disease.',
      storageInfo: 'Store below 25°C in a dry place, out of sight and reach of children.',
      officialSourceUrl: 'https://www.vitabiotics.com/products/ultra-vitamin-d-1000iu-96-tablets',
      unitPriceCents: 2800,
      costPriceCents: 1250,
      stockQuantity: 48,
      reorderThreshold: 15,
      reorderQuantity: 40,
      lotNumber: 'LOT-VD3-26A',
      expiryDate: '2028-06-30',
      requiresPrescription: 0,
    },
    {
      id: 'inv_feroglobin',
      ndcCode: '5021265-2009',
      name: 'Vitabiotics Feroglobin Liquid Iron + B12 (200ml)',
      category: 'Vitamins & Wellness',
      description: 'Gentle honey & orange liquid iron tonic with B6, B12, folic acid, and zinc to support healthy blood & energy.',
      imageUrl: '/drug-images/inv_feroglobin.png',
      manufacturerName: 'Vitabiotics Ltd (UK)',
      activeIngredient: 'Iron (Ferric Ammonium Citrate) 14 mg/10 mL + Folic Acid, Vitamins B1, B2, B6, B12, C & Zinc',
      dosageForm: 'Liquid tonic · 200 mL glass bottle',
      usageDirections: 'Shake well before use. Adults: Take 1 teaspoon (5 mL) twice daily after meals. Children 3–6 years: 1/2 to 1 tsp daily. Use within 3 months of opening.',
      warnings: 'Contains iron—keep out of reach of children. Do not use if you have hemochromatosis (iron overload), allergy to honey, barley malt, or sulphites. Avoid taking with tea or coffee.',
      storageInfo: 'Store below 25°C away from direct sunlight. Refrigerate or keep cool after opening and finish within 3 months.',
      officialSourceUrl: 'https://www.vitabiotics.com/products/feroglobin-liquid',
      unitPriceCents: 4500,
      costPriceCents: 2300,
      stockQuantity: 34,
      reorderThreshold: 12,
      reorderQuantity: 30,
      lotNumber: 'LOT-FER-26R',
      expiryDate: '2028-05-31',
      requiresPrescription: 0,
    },
    {
      id: 'inv_vitc_zinc',
      ndcCode: '5021265-2061',
      name: 'Vitabiotics Ultra Vitamin C Fizz 1000mg + Zinc (20ct)',
      category: 'Vitamins & Wellness',
      description: 'Effervescent citrus immune support tablets combining 1000mg Vitamin C with Zinc for daily antioxidant defense.',
      imageUrl: '/drug-images/inv_vitc_zinc.png',
      manufacturerName: 'Vitabiotics Ltd (UK)',
      activeIngredient: 'Vitamin C (Ascorbic Acid) 1000 mg + Zinc 10 mg per effervescent tablet',
      dosageForm: 'Effervescent tablets · Tube of 20',
      usageDirections: 'Adults and children 12+ years: Dissolve 1 tablet in a glass of water (approx. 200 mL) once daily to make a refreshing orange drink.',
      warnings: 'Do not exceed 1 tablet per day. Consult a doctor if you have kidney stones (oxalate) or kidney impairment. Keep tube tightly capped.',
      storageInfo: 'Store below 25°C in a dry place with tube tightly sealed.',
      officialSourceUrl: 'https://www.vitabiotics.com/products/ultra-vitamin-c-fizz-effervescent-tablets',
      unitPriceCents: 2600,
      costPriceCents: 1150,
      stockQuantity: 58,
      reorderThreshold: 15,
      reorderQuantity: 45,
      lotNumber: 'LOT-VTC-26S',
      expiryDate: '2028-08-15',
      requiresPrescription: 0,
    },

    // Devices & First Aid
    {
      id: 'inv_bpmon',
      ndcCode: '4015672-1135-0',
      name: 'Omron M3 Comfort Digital Upper-Arm BP Monitor',
      category: 'Devices & First Aid',
      description: 'Clinically validated Intellisense blood pressure monitor with 360° Intelli Wrap Cuff (22–42 cm) and AFib/irregular heartbeat alert.',
      imageUrl: '/drug-images/inv_bpmon.png',
      manufacturerName: 'Omron Healthcare',
      activeIngredient: 'Oscillometric automated upper-arm blood pressure & pulse monitor (Model HEM-7196T1-FLE)',
      dosageForm: 'Medical diagnostic device · Monitor + Intelli Wrap Cuff + 4× AA batteries + Carry Case',
      usageDirections: 'Rest quietly seated for 5 minutes with feet flat. Wrap cuff snugly 1–2 cm above the elbow crease on bare skin at heart level, then press START. Supports 2 users × 60 readings memory.',
      warnings: 'Do not apply cuff over an injured arm, drip line, or mastectomy side. Discuss repeated high readings (>140/90 mmHg) or AFib alerts with your pharmacist or doctor.',
      storageInfo: 'Store in carry case at 10°C to 40°C away from moisture and direct sunlight.',
      officialSourceUrl: 'https://www.omron-healthcare.co.uk/products/m3-comfort-afib',
      unitPriceCents: 29500,
      costPriceCents: 19800,
      stockQuantity: 18,
      reorderThreshold: 8,
      reorderQuantity: 15,
      lotNumber: 'LOT-BPM-26C',
      expiryDate: '2030-01-15',
      requiresPrescription: 0,
    },
    {
      id: 'inv_glucometer',
      ndcCode: '4015630-0812-5',
      name: 'Accu-Chek Instant Blood Glucose Meter + 25 Strips',
      category: 'Devices & First Aid',
      description: 'No-coding Roche blood sugar meter with <4 second results, color target-range indicator, and Bluetooth mySugr sync.',
      imageUrl: '/drug-images/inv_glucometer.png',
      manufacturerName: 'Roche Diabetes Care (Accu-Chek)',
      activeIngredient: 'In-vitro diagnostic blood glucose monitoring kit (0.6 µL sample size, 720-reading memory)',
      dosageForm: 'Diagnostic kit · Instant Meter + Softclix Lancing Device + 25 Test Strips',
      usageDirections: 'Wash and dry hands thoroughly. Insert an Accu-Chek Instant strip, prick side of fingertip with lancing device, and touch the wide yellow dosing edge to the blood drop. Read result in under 4 seconds.',
      warnings: 'Use only genuine Accu-Chek Instant test strips and fresh single-use lancets for each person. Never share lancets. Check strip expiry date before testing.',
      storageInfo: 'Store meter and tightly capped strip vial between 4°C and 30°C in a dry place.',
      officialSourceUrl: 'https://www.accu-chek.co.uk/products/meters/instant',
      unitPriceCents: 18500,
      costPriceCents: 11200,
      stockQuantity: 14,
      reorderThreshold: 6,
      reorderQuantity: 12,
      lotNumber: 'LOT-GLU-26T',
      expiryDate: '2029-12-31',
      requiresPrescription: 0,
    },
    {
      id: 'inv_firstaid',
      ndcCode: 'GHA-DFA-001-10',
      name: 'Betadine Povidone-Iodine 10% Antiseptic Solution Kit',
      category: 'Devices & First Aid',
      description: 'Broad-spectrum antimicrobial antiseptic solution for minor cuts, scrapes, burns, and wound dressing care.',
      imageUrl: '/drug-images/inv_firstaid.png',
      manufacturerName: 'Mundipharma / Avrio Health (Betadine)',
      activeIngredient: 'Povidone-Iodine 10% w/v (equivalent to 1% available iodine)',
      dosageForm: 'Topical antiseptic solution · 120 mL bottle + sterile gauze & plasters',
      usageDirections: 'Clean the minor wound gently with clean water, apply Betadine 10% solution directly 1 to 3 times daily, allow to dry, and cover with sterile gauze or plaster.',
      warnings: 'For external use only. Do not use in deep puncture wounds, serious burns, or if allergic to iodine. Consult a doctor if redness/swelling worsens or if pregnant/thyroid condition.',
      storageInfo: 'Store below 25°C with cap tightly closed.',
      officialSourceUrl: 'https://betadine.com/betadine-products/betadine-antiseptic-solution/',
      unitPriceCents: 3500,
      costPriceCents: 1600,
      stockQuantity: 26,
      reorderThreshold: 10,
      reorderQuantity: 24,
      lotNumber: 'LOT-FAD-26U',
      expiryDate: '2029-06-30',
      requiresPrescription: 0,
    },
  ];

  const insertInv = db.prepare(`
    INSERT OR IGNORE INTO inventory (
      id, ndc_code, name, category, description, image_url,
      manufacturer_name, active_ingredient, dosage_form, usage_directions, warnings, storage_info, official_source_url,
      unit_price_cents, cost_price_cents, stock_quantity, reorder_threshold, reorder_quantity,
      lot_number, expiry_date, supplier_id, supplier_name, auto_reorder_enabled, requires_prescription
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'usr_supplier_apex', 'Ernest & Tobinko MedSupply Ghana', 1, ?)
  `);

  const enrichExistingInv = db.prepare(`
    UPDATE inventory
    SET
      name = ?,
      description = ?,
      image_url = ?,
      manufacturer_name = ?,
      active_ingredient = ?,
      dosage_form = ?,
      usage_directions = ?,
      warnings = ?,
      storage_info = ?,
      official_source_url = ?
    WHERE id = ? AND (manufacturer_name = '' OR manufacturer_name IS NULL OR image_url IS NULL OR image_url LIKE '/src/assets/images/%')
  `);

  for (const item of catalogItems) {
    insertInv.run(
      item.id,
      item.ndcCode,
      item.name,
      item.category,
      item.description,
      item.imageUrl,
      item.manufacturerName,
      item.activeIngredient,
      item.dosageForm,
      item.usageDirections,
      item.warnings,
      item.storageInfo,
      item.officialSourceUrl,
      item.unitPriceCents,
      item.costPriceCents,
      item.stockQuantity,
      item.reorderThreshold,
      item.reorderQuantity,
      item.lotNumber,
      item.expiryDate,
      item.requiresPrescription
    );
    enrichExistingInv.run(
      item.name,
      item.description,
      item.imageUrl,
      item.manufacturerName,
      item.activeIngredient,
      item.dosageForm,
      item.usageDirections,
      item.warnings,
      item.storageInfo,
      item.officialSourceUrl,
      item.id
    );
  }

  // 3. Populate Pharmacy Walk-In Services (BP, Sugar, Malaria, Pregnancy, etc.)
  const insertService = db.prepare(`
    INSERT OR IGNORE INTO pharmacy_services (
      id, name, category, turnaround_minutes, price_cents, notes, active
    ) VALUES (?, ?, ?, ?, ?, ?, 1)
  `);

  const servicesSeed: Array<[string, string, string, number, number, string]> = [
    [
      'srv_bp',
      'Blood Pressure (BP) Check',
      'Vital Signs',
      5,
      1000,
      'Sitting digital cuff reading with pharmacist advice on your numbers.',
    ],
    [
      'srv_sugar',
      'Blood Sugar (Glucose) Test',
      'Rapid Screening',
      5,
      2500,
      'Quick finger-prick fasting or random blood sugar check in mmol/L.',
    ],
    [
      'srv_malaria',
      'Malaria Rapid Test (RDT)',
      'Rapid Screening',
      15,
      3500,
      'Same-visit malaria antigen test before starting antimalarial medicine.',
    ],
    [
      'srv_preg',
      'Pregnancy Test (hCG)',
      'Rapid Screening',
      5,
      2000,
      'Private and quick urine hCG screening with confidential pharmacist guidance.',
    ],
    [
      'srv_typhoid',
      'Typhoid Screening',
      'Rapid Screening',
      15,
      4500,
      'Rapid antibody screening for persistent fever and stomach symptoms.',
    ],
    [
      'srv_hb',
      'Hemoglobin (Blood Level) Test',
      'Rapid Screening',
      5,
      3000,
      'Quick check for low blood level / anemia before iron supplements.',
    ],
    [
      'srv_chol',
      'Cholesterol Check',
      'Rapid Screening',
      10,
      6500,
      'Finger-prick total cholesterol check for heart and lipid tracking.',
    ],
    [
      'srv_bmi',
      'Weight & BMI Check',
      'Wellness Check',
      5,
      1000,
      'Height, weight, and body mass index measurement for wellness tracking.',
    ],
  ];

  for (const srv of servicesSeed) {
    insertService.run(...srv);
  }

  const existingLogs = db.prepare(`SELECT COUNT(*) as count FROM service_logs`).get() as {
    count: number;
  };
  if (existingLogs.count === 0) {
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const todayIso = new Date().toISOString();
    const insertLog = db.prepare(`
      INSERT INTO service_logs (
        id, service_id, service_name, patient_name, result_value, notes, price_cents, recorded_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertLog.run(
      'slog_101',
      'srv_bp',
      'Blood Pressure (BP) Check',
      'Ama Serwaa Mensah',
      '118/76 mmHg',
      'Normal reading on morning Lisinopril 10mg.',
      1000,
      'Pharm. Akosua Osei, MPSGH',
      yesterday
    );
    insertLog.run(
      'slog_102',
      'srv_sugar',
      'Blood Sugar (Glucose) Test',
      'Kwame Boateng',
      '5.9 mmol/L (Fasting)',
      'Good morning sugar control with Metformin ER.',
      2500,
      'Pharm. Akosua Osei, MPSGH',
      todayIso
    );
  }
}
