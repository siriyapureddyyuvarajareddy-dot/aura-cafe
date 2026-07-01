const { createClient } = require('@libsql/client');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let client;
const isTurso = !!process.env.TURSO_DATABASE_URL;

if (isTurso) {
  console.log('Connected to Turso database:', process.env.TURSO_DATABASE_URL);
  client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
  });
} else {
  const dbPath = process.env.DATABASE_PATH || (process.env.NODE_ENV === 'test'
    ? path.join(__dirname, 'test_aura_cafe.db')
    : path.join(__dirname, 'aura_cafe.db'));

  // Ensure db file directory exists
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const absolutePath = path.resolve(dbPath);
  const fileUrl = 'file:' + absolutePath;
  console.log('Connected to local SQLite database via libSQL:', fileUrl);
  client = createClient({
    url: fileUrl
  });
}

// Keep db variable pointing to client for compatibility
const db = client;

// Helper wrapper to use async/await with libSQL Client
const dbQuery = {
  run: async (sql, params = []) => {
    const result = await client.execute({ sql, args: params });
    return {
      id: result.lastInsertRowid !== undefined && result.lastInsertRowid !== null
        ? Number(result.lastInsertRowid)
        : undefined,
      changes: result.rowsAffected
    };
  },
  get: async (sql, params = []) => {
    const result = await client.execute({ sql, args: params });
    if (result.rows.length === 0) return undefined;
    return { ...result.rows[0] };
  },
  all: async (sql, params = []) => {
    const result = await client.execute({ sql, args: params });
    return result.rows.map(row => ({ ...row }));
  },
  exec: async (sql) => {
    await client.execute(sql);
  }
};

// Initialize schema
async function initDb() {
  // Users table for Admin Authentication
  await dbQuery.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT CHECK(role IN ('admin', 'staff')) DEFAULT 'admin',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Admins table
  await dbQuery.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_code TEXT,
      full_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT CHECK(role IN ('Super Admin', 'Admin')) DEFAULT 'Admin',
      status TEXT CHECK(status IN ('Active', 'Inactive')) DEFAULT 'Active',
      last_login TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Trigger to generate admin_code in ADM-1001 format
  await dbQuery.exec(`
    CREATE TRIGGER IF NOT EXISTS generate_admin_code
    AFTER INSERT ON admins
    BEGIN
      UPDATE admins
      SET admin_code = 'ADM-' || (1000 + NEW.id)
      WHERE id = NEW.id;
    END;
  `);

  // Sessions table to persist active login sessions across server restarts
  await dbQuery.exec(`
    CREATE TABLE IF NOT EXISTS active_sessions (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Admin login logs for auditing
  await dbQuery.exec(`
    CREATE TABLE IF NOT EXISTS admin_login_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER,
      full_name TEXT,
      username TEXT NOT NULL,
      login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ip_address TEXT,
      user_agent TEXT,
      status TEXT NOT NULL,
      reason TEXT
    )
  `);

  // Migrate legacy active session roles to new format
  await dbQuery.run("UPDATE active_sessions SET role = 'Super Admin' WHERE role = 'admin'");
  await dbQuery.run("UPDATE active_sessions SET role = 'Admin' WHERE role = 'staff'");



  // Table Bookings
  await dbQuery.exec(`
    CREATE TABLE IF NOT EXISTS hotel_restaurant_table_booking_menu (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guest_name TEXT NOT NULL,
      guest_type TEXT CHECK(guest_type IN ('Hotel Guest', 'Walk-in')) NOT NULL,
      room_number TEXT,
      table_number INTEGER,
      booking_date TEXT NOT NULL,
      booking_time TEXT NOT NULL,
      guest_count INTEGER NOT NULL,
      dietary_preference TEXT CHECK(dietary_preference IN ('None', 'Vegetarian', 'Vegan', 'Gluten-Free', 'Nut-Allergy', 'Non-Veg', 'Starters')) DEFAULT 'None',
      status TEXT CHECK(status IN ('Active', 'Completed', 'Cancelled', 'Archived')) DEFAULT 'Active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migration: Make table_number nullable if it was defined as NOT NULL
  const tableInfo = await dbQuery.all("PRAGMA table_info(hotel_restaurant_table_booking_menu)");
  const tableNumCol = tableInfo.find(c => c.name === 'table_number');
  if (tableNumCol && tableNumCol.notnull === 1) {
    console.log('Migrating hotel_restaurant_table_booking_menu: dropping NOT NULL constraint from table_number...');
    await dbQuery.exec("PRAGMA foreign_keys=OFF;");
    await dbQuery.exec("BEGIN TRANSACTION;");
    await dbQuery.exec("ALTER TABLE hotel_restaurant_table_booking_menu RENAME TO _hotel_restaurant_table_booking_menu_old;");
    await dbQuery.exec(`
      CREATE TABLE hotel_restaurant_table_booking_menu (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guest_name TEXT NOT NULL,
        guest_type TEXT CHECK(guest_type IN ('Hotel Guest', 'Walk-in')) NOT NULL,
        room_number TEXT,
        table_number INTEGER,
        booking_date TEXT NOT NULL,
        booking_time TEXT NOT NULL,
        guest_count INTEGER NOT NULL,
        dietary_preference TEXT CHECK(dietary_preference IN ('None', 'Vegetarian', 'Vegan', 'Gluten-Free', 'Nut-Allergy', 'Non-Veg', 'Starters')) DEFAULT 'None',
        status TEXT CHECK(status IN ('Active', 'Completed', 'Cancelled', 'Archived')) DEFAULT 'Active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dbQuery.exec(`
      INSERT INTO hotel_restaurant_table_booking_menu (
        id, guest_name, guest_type, room_number, table_number, booking_date, booking_time, guest_count, dietary_preference, status, created_at, updated_at
      )
      SELECT 
        id, guest_name, guest_type, room_number, table_number, booking_date, booking_time, guest_count, dietary_preference, status, created_at, updated_at
      FROM _hotel_restaurant_table_booking_menu_old;
    `);
    await dbQuery.exec("DROP TABLE _hotel_restaurant_table_booking_menu_old;");
    await dbQuery.exec("COMMIT;");
    await dbQuery.exec("PRAGMA foreign_keys=ON;");
    console.log('Database table_number nullability migration complete.');
  }

  // Migration: Update dietary_preference CHECK constraint to include 'Non-Veg' and 'Starters'
  const masterInfo = await dbQuery.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='hotel_restaurant_table_booking_menu'");
  if (masterInfo && masterInfo.sql && (!masterInfo.sql.includes("'Non-Veg'") || !masterInfo.sql.includes("'Starters'"))) {
    console.log("Migrating hotel_restaurant_table_booking_menu: updating CHECK constraint on dietary_preference to include 'Non-Veg' and 'Starters'...");
    await dbQuery.exec("PRAGMA foreign_keys=OFF;");
    await dbQuery.exec("BEGIN TRANSACTION;");
    await dbQuery.exec("ALTER TABLE hotel_restaurant_table_booking_menu RENAME TO _hotel_restaurant_table_booking_menu_old2;");
    await dbQuery.exec(`
      CREATE TABLE hotel_restaurant_table_booking_menu (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guest_name TEXT NOT NULL,
        guest_type TEXT CHECK(guest_type IN ('Hotel Guest', 'Walk-in')) NOT NULL,
        room_number TEXT,
        table_number INTEGER,
        booking_date TEXT NOT NULL,
        booking_time TEXT NOT NULL,
        guest_count INTEGER NOT NULL,
        dietary_preference TEXT CHECK(dietary_preference IN ('None', 'Vegetarian', 'Vegan', 'Gluten-Free', 'Nut-Allergy', 'Non-Veg', 'Starters')) DEFAULT 'None',
        status TEXT CHECK(status IN ('Active', 'Completed', 'Cancelled', 'Archived')) DEFAULT 'Active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dbQuery.exec(`
      INSERT INTO hotel_restaurant_table_booking_menu (
        id, guest_name, guest_type, room_number, table_number, booking_date, booking_time, guest_count, dietary_preference, status, created_at, updated_at
      )
      SELECT 
        id, guest_name, guest_type, room_number, table_number, booking_date, booking_time, guest_count, dietary_preference, status, created_at, updated_at
      FROM _hotel_restaurant_table_booking_menu_old2;
    `);
    await dbQuery.exec("DROP TABLE _hotel_restaurant_table_booking_menu_old2;");
    await dbQuery.exec("COMMIT;");
    await dbQuery.exec("PRAGMA foreign_keys=ON;");
    console.log("Database dietary_preference CHECK constraint migration complete.");
  }

  // Menu items (static list for reference)
  await dbQuery.exec(`
    CREATE TABLE IF NOT EXISTS menu_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      price REAL NOT NULL,
      dietary_tags TEXT NOT NULL,
      image_url TEXT
    )
  `);

  // Migration: Add image_url column to menu_items if it doesn't exist
  const menuInfo = await dbQuery.all("PRAGMA table_info(menu_items)");
  const hasImageUrl = menuInfo.some(c => c.name === 'image_url');
  if (!hasImageUrl) {
    console.log("Migrating menu_items: adding image_url column...");
    await dbQuery.run("ALTER TABLE menu_items ADD COLUMN image_url TEXT");
  }
  const hasIsAvailable = menuInfo.some(c => c.name === 'is_available');
  if (!hasIsAvailable) {
    console.log("Migrating menu_items: adding is_available column...");
    await dbQuery.run("ALTER TABLE menu_items ADD COLUMN is_available INTEGER DEFAULT 1");
  }

  // Orders associated with table bookings
  await dbQuery.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER REFERENCES hotel_restaurant_table_booking_menu(id) ON DELETE CASCADE,
      item_name TEXT NOT NULL,
      category TEXT NOT NULL,
      price REAL NOT NULL,
      quantity INTEGER NOT NULL,
      dietary_tags TEXT NOT NULL,
      status TEXT CHECK(status IN ('Pending', 'Served', 'Cancelled')) DEFAULT 'Pending'
    )
  `);

  // Migration: Update orders foreign key reference if pointing to renamed table
  const ordersMaster = await dbQuery.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'");
  if (ordersMaster && ordersMaster.sql && ordersMaster.sql.includes('_hotel_restaurant_table_booking_menu_old')) {
    console.log("Migrating orders: fixing broken foreign key reference pointing to renamed old table...");
    await dbQuery.exec("PRAGMA foreign_keys=OFF;");
    await dbQuery.exec("BEGIN TRANSACTION;");
    await dbQuery.exec("ALTER TABLE orders RENAME TO _orders_old;");
    await dbQuery.exec(`
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_id INTEGER REFERENCES hotel_restaurant_table_booking_menu(id) ON DELETE CASCADE,
        item_name TEXT NOT NULL,
        category TEXT NOT NULL,
        price REAL NOT NULL,
        quantity INTEGER NOT NULL,
        dietary_tags TEXT NOT NULL,
        status TEXT CHECK(status IN ('Pending', 'Served', 'Cancelled')) DEFAULT 'Pending'
      )
    `);
    await dbQuery.exec(`
      INSERT INTO orders (id, booking_id, item_name, category, price, quantity, dietary_tags, status)
      SELECT id, booking_id, item_name, category, price, quantity, dietary_tags, status
      FROM _orders_old;
    `);
    await dbQuery.exec("DROP TABLE _orders_old;");
    await dbQuery.exec("COMMIT;");
    await dbQuery.exec("PRAGMA foreign_keys=ON;");
    console.log("Database orders foreign key reference migration complete.");
  }

  // Payments integration
  await dbQuery.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER REFERENCES hotel_restaurant_table_booking_menu(id) ON DELETE CASCADE,
      payment_method TEXT CHECK(payment_method IN ('Card', 'Cash', 'Room Charge', 'Unpaid', 'UPI')) DEFAULT 'Unpaid',
      subtotal REAL DEFAULT 0.0,
      discount REAL DEFAULT 0.0,
      tax REAL DEFAULT 0.0,
      total_amount REAL DEFAULT 0.0,
      status TEXT CHECK(status IN ('Unpaid', 'Paid', 'Refunded')) DEFAULT 'Unpaid',
      payment_date TEXT
    )
  `);

  // Migration: Update payment_method CHECK constraint to include 'UPI'
  const paymentsMaster = await dbQuery.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='payments'");
  if (paymentsMaster && paymentsMaster.sql && !paymentsMaster.sql.includes("'UPI'")) {
    console.log("Migrating payments: updating CHECK constraint on payment_method to include 'UPI'...");
    await dbQuery.exec("PRAGMA foreign_keys=OFF;");
    await dbQuery.exec("BEGIN TRANSACTION;");
    await dbQuery.exec("ALTER TABLE payments RENAME TO _payments_old;");
    await dbQuery.exec(`
      CREATE TABLE payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_id INTEGER REFERENCES hotel_restaurant_table_booking_menu(id) ON DELETE CASCADE,
        payment_method TEXT CHECK(payment_method IN ('Card', 'Cash', 'Room Charge', 'Unpaid', 'UPI')) DEFAULT 'Unpaid',
        subtotal REAL DEFAULT 0.0,
        discount REAL DEFAULT 0.0,
        tax REAL DEFAULT 0.0,
        total_amount REAL DEFAULT 0.0,
        status TEXT CHECK(status IN ('Unpaid', 'Paid', 'Refunded')) DEFAULT 'Unpaid',
        payment_date TEXT
      )
    `);
    await dbQuery.exec(`
      INSERT INTO payments (id, booking_id, payment_method, subtotal, discount, tax, total_amount, status)
      SELECT id, booking_id, payment_method, subtotal, discount, tax, total_amount, status
      FROM _payments_old;
    `);
    await dbQuery.exec("DROP TABLE _payments_old;");
    await dbQuery.exec("COMMIT;");
    await dbQuery.exec("PRAGMA foreign_keys=ON;");
    console.log("Database payments CHECK constraint migration complete.");
  }

  // Migration: Add payment_date column if missing (for existing databases)
  const paymentsInfo = await dbQuery.all("PRAGMA table_info(payments)");
  const hasPaymentDate = paymentsInfo.some(c => c.name === 'payment_date');
  if (!hasPaymentDate) {
    console.log("Migrating payments: adding payment_date column...");
    await dbQuery.run("ALTER TABLE payments ADD COLUMN payment_date TEXT");
    // Backfill payment_date for existing paid payments
    await dbQuery.run(`
      UPDATE payments 
      SET payment_date = (
        SELECT booking_date 
        FROM hotel_restaurant_table_booking_menu 
        WHERE id = payments.booking_id
      ) 
      WHERE status = 'Paid' AND payment_date IS NULL
    `);
    console.log("Database payments payment_date migration complete.");
  }

  // Migration: Add new columns to hotel_restaurant_table_booking_menu for Feature 2 and Feature 4
  const bookingInfo = await dbQuery.all("PRAGMA table_info(hotel_restaurant_table_booking_menu)");
  const addBookingColumnIfMissing = async (colName, colType) => {
    if (!bookingInfo.some(c => c.name === colName)) {
      console.log(`Migrating hotel_restaurant_table_booking_menu: adding ${colName} column...`);
      try {
        await dbQuery.run(`ALTER TABLE hotel_restaurant_table_booking_menu ADD COLUMN ${colName} ${colType}`);
      } catch (err) {
        console.error(`Error adding column ${colName}:`, err.message);
      }
    }
  };
  await addBookingColumnIfMissing('phone', 'TEXT');
  await addBookingColumnIfMissing('email', 'TEXT');
  await addBookingColumnIfMissing('reminder_sent', 'INTEGER DEFAULT 0');
  await addBookingColumnIfMissing('feedback_sent', 'INTEGER DEFAULT 0');
  await addBookingColumnIfMissing('payment_status', "TEXT DEFAULT 'pending'");
  await addBookingColumnIfMissing('payment_id', 'TEXT');
  await addBookingColumnIfMissing('razorpay_order_id', 'TEXT');

  // Create feedback table for Feature 3
  await dbQuery.exec(`
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER REFERENCES hotel_restaurant_table_booking_menu(id) ON DELETE CASCADE,
      guest_name TEXT NOT NULL,
      overall_rating INTEGER NOT NULL,
      food_rating INTEGER NOT NULL,
      service_rating INTEGER NOT NULL,
      ambience_rating INTEGER NOT NULL,
      comment TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);




  // Seed Menu Items if empty
  const menuCount = await dbQuery.get('SELECT COUNT(*) as count FROM menu_items');
  if (menuCount.count === 0) {
    const items = [
      // VEG BURGERS
      ['Crispy Veg Burger', 'Veg Burgers', 99.00, 'None', 'images/crispy_veg_burger.png'],
      ['Paneer Burger', 'Veg Burgers', 119.00, 'None', 'https://images.unsplash.com/photo-1525059696034-4967a8e1dca2'],
      ['Veg Mini Burger 8Pic', 'Veg Burgers', 79.00, 'None', 'images/veg_mini_burger_8pic.png'],

      // EGG
      ['Plain Egg', 'Egg Items', 29.00, 'None', 'https://images.unsplash.com/photo-1587486913049-53fc88980cfc'],
      ['Scrambled Egg', 'Egg Items', 39.00, 'None', 'images/scrambled_egg.png'],
      ['Bread Omlete', 'Egg Items', 70.00, 'None', 'https://images.unsplash.com/photo-1525351484163-7529414344d8'],
      ['Sunny Side Up', 'Egg Items', 29.00, 'None', 'images/sunny_side_up.png'],
      ['Cheese omlete', 'Egg Items', 39.00, 'None', 'images/cheese_omlete.png'],

      // NON VEG BURGERS
      ['Crispy Chicken Burger', 'Non-Veg Burgers', 119.00, 'None', 'images/crispy_chicken_burger.png'],
      ['BBQ Chicken Burger', 'Non-Veg Burgers', 129.00, 'None', 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd'],
      ['Chicken Smash Burger', 'Non-Veg Burgers', 139.00, 'None', 'images/chicken_smash_burger.png'],
      ['Chicken Mini Burger 8 Pic', 'Non-Veg Burgers', 99.00, 'None', 'images/chicken_mini_burger_8pic.png'],

      // FRIED VEG
      ['French Fries', 'Fried Veg', 69.00, 'None', 'https://images.unsplash.com/photo-1576107232684-1279f390859f'],
      ['Peri Peri Fries', 'Fried Veg', 89.00, 'None', 'https://images.unsplash.com/photo-1573080496219-bb080dd4f877'],
      ['Veg Fried Chees Balls', 'Fried Veg', 79.00, 'None', 'images/veg_fried_cheese_balls.png'],
      ['Smiley Fries', 'Fried Veg', 69.00, 'None', 'images/smiley_fries.png'],
      ['Veg Nuggets', 'Fried Veg', 79.00, 'None', 'https://images.unsplash.com/photo-1562967914-608f82629710'],

      // VEG STARTERS
      ['Chilli Paneer', 'Veg Starters', 79.00, 'None', 'images/chilli_paneer.png'],
      ['Gobi 65', 'Veg Starters', 69.00, 'None', 'images/gobi_65.png'],
      ['Chilli Mushroom', 'Veg Starters', 95.00, 'None', 'images/chilli_mushroom.png'],
      ['Mushroom 65', 'Veg Starters', 89.00, 'None', 'images/mushroom_65.png'],
      ['Paneer Manchurian', 'Veg Starters', 99.00, 'None', 'images/paneer_manchurian.png'],
      ['Paneer 65', 'Veg Starters', 89.00, 'None', 'images/paneer_65.png'],
      ['Baby Corn Starter', 'Veg Starters', 89.00, 'None', 'images/crispy_baby_corn.jpg'],
      ['Gobi Manchurian', 'Veg Starters', 69.00, 'None', 'images/gobi_manchurian.png'],

      // NON-VEG STARTERS
      ['Chicken 65', 'Non-Veg Starters', 120.00, 'None', 'https://images.unsplash.com/photo-1603360946369-dc9bb6258143'],
      ['Chilli Chicken', 'Non-Veg Starters', 139.00, 'None', 'images/chilli_chicken.png'],
      ['Lemon Chicken', 'Non-Veg Starters', 140.00, 'None', 'images/lemon_chicken.png'],
      ['Pepper Chicken', 'Non-Veg Starters', 140.00, 'None', 'images/pepper_chicken.png'],
      ['Garlic Chicken', 'Non-Veg Starters', 119.00, 'None', 'https://images.unsplash.com/photo-1603360946369-dc9bb6258143'],
      ['Dragon Chicken', 'Non-Veg Starters', 160.00, 'None', 'https://images.unsplash.com/photo-1527324688151-0e627063f2b1'],
      ['Kaju Chicken', 'Non-Veg Starters', 159.00, 'None', 'images/kaju_chicken.png'],
      ['Juicy Lolipop', 'Non-Veg Starters', 180.00, 'None', 'images/juicy_lolipop.png'],
      ['Dry Chicken', 'Non-Veg Starters', 139.00, 'None', 'images/dry_chicken.png'],
      ['Chilly Prawns', 'Non-Veg Starters', 170.00, 'None', 'images/chilly_prawns.png'],
      ['Prawns 65', 'Non-Veg Starters', 149.00, 'None', 'images/prawns_65.png'],
      ['Prawns Pepper', 'Non-Veg Starters', 190.00, 'None', 'images/prawns_pepper.png'],
      ['Prawns Manchurian', 'Non-Veg Starters', 190.00, 'None', 'images/prawns_manchurian.png'],

      // BIRYANI
      ['Peddamma Biriyani', 'Biryani', 140.00, 'None', 'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8'],

      // VEG FRIED RICE
      ['Veg Fried Rice (Normal)', 'Fried Rice', 69.00, 'None', 'https://images.unsplash.com/photo-1601050690597-df056fb4ce78'],
      ['Veg Fried Rice (Schezwan)', 'Fried Rice', 79.00, 'None', 'https://images.unsplash.com/photo-1601050690597-df056fb4ce78'],
      ['Panner Fried Rice (Normal)', 'Fried Rice', 100.00, 'None', 'https://images.unsplash.com/photo-1534422298391-e4f8c172dddb'],
      ['Panner Fried Rice (Schezwan)', 'Fried Rice', 110.00, 'None', 'https://images.unsplash.com/photo-1534422298391-e4f8c172dddb'],
      ['Mushroom Fried Rice (Normal)', 'Fried Rice', 89.00, 'None', 'https://images.unsplash.com/photo-1601050690597-df056fb4ce78'],
      ['Mushroom Fried Rice (Schezwan)', 'Fried Rice', 99.00, 'None', 'https://images.unsplash.com/photo-1601050690597-df056fb4ce78'],
      ['Mixed Veg Fried Rice (Normal)', 'Fried Rice', 120.00, 'None', 'https://images.unsplash.com/photo-1601050690597-df056fb4ce78'],
      ['Mixed Veg Fried Rice (Schezwan)', 'Fried Rice', 140.00, 'None', 'https://images.unsplash.com/photo-1601050690597-df056fb4ce78'],
      ['Ghee Rice', 'Fried Rice', 79.00, 'None', 'https://images.unsplash.com/photo-1601050690597-df056fb4ce78'],

      // FRIED RICE NON-VEG
      ['Chicken Fried Rice (Normal)', 'Fried Rice', 120.00, 'None', 'images/chicken_fried_rice_normal.png'],
      ['Chicken Fried Rice (Schezwan)', 'Fried Rice', 140.00, 'None', 'images/chicken_fried_rice_schezwan.png'],
      ['Chicken Keema Rice (Normal)', 'Fried Rice', 119.00, 'None', 'images/chicken_keema_rice_normal.png'],
      ['Chicken Keema Rice (Schezwan)', 'Fried Rice', 119.00, 'None', 'images/chicken_keema_rice_schezwan.png'],
      ['Egg Rice (Normal)', 'Fried Rice', 100.00, 'None', 'https://images.unsplash.com/photo-1587486913049-53fc88980cfc'],
      ['Egg Rice (Schezwan)', 'Fried Rice', 120.00, 'None', 'https://images.unsplash.com/photo-1587486913049-53fc88980cfc'],
      ['Prawns Rice (Normal)', 'Fried Rice', 150.00, 'None', 'https://images.unsplash.com/photo-1565557623262-b51c2513a641'],
      ['Prawns Rice (Schezwan)', 'Fried Rice', 170.00, 'None', 'https://images.unsplash.com/photo-1565557623262-b51c2513a641'],

      // MOMO'S
      ["Veg Steamed Momo's", 'Momos', 75.00, 'None', 'https://images.unsplash.com/photo-1534422298391-e4f8c172dddb'],
      ["Veg Fried Momo's", 'Momos', 85.00, 'None', 'https://images.unsplash.com/photo-1534422298391-e4f8c172dddb'],
      ["Chicken Steamed Momo's", 'Momos', 109.00, 'None', 'https://images.unsplash.com/photo-1534422298391-e4f8c172dddb'],
      ["Chicken Fried Momo's", 'Momos', 119.00, 'None', 'https://images.unsplash.com/photo-1534422298391-e4f8c172dddb'],

      // NOODLES
      ['Veg Fried Noodles (Normal)', 'Noodles', 69.00, 'None', 'https://images.unsplash.com/photo-1585032226651-759b368d7246'],
      ['Veg Fried Noodles (Schezwan)', 'Noodles', 79.00, 'None', 'https://images.unsplash.com/photo-1585032226651-759b368d7246'],
      ['Panner Fried Noodles (Normal)', 'Noodles', 100.00, 'None', 'https://images.unsplash.com/photo-1534422298391-e4f8c172dddb'],
      ['Panner Fried Noodles (Schezwan)', 'Noodles', 110.00, 'None', 'https://images.unsplash.com/photo-1534422298391-e4f8c172dddb'],
      ['Mushroom Noodles (Normal)', 'Noodles', 99.00, 'None', 'https://images.unsplash.com/photo-1585032226651-759b368d7246'],
      ['Mushroom Noodles (Schezwan)', 'Noodles', 109.00, 'None', 'https://images.unsplash.com/photo-1585032226651-759b368d7246'],
      ['Gobi Fried Noodles (Normal)', 'Noodles', 79.00, 'None', 'https://images.unsplash.com/photo-1585032226651-759b368d7246'],
      ['Gobi Fried Noodles (Schezwan)', 'Noodles', 89.00, 'None', 'https://images.unsplash.com/photo-1585032226651-759b368d7246'],
      ['Mixed Veg Noodles (Normal)', 'Noodles', 119.00, 'None', 'https://images.unsplash.com/photo-1585032226651-759b368d7246'],
      ['Mixed Veg Noodles (Schezwan)', 'Noodles', 129.00, 'None', 'https://images.unsplash.com/photo-1585032226651-759b368d7246'],

      // NOODLES NON-VEG
      ['Chicken Noodles (Normal)', 'Noodles', 120.00, 'None', 'https://images.unsplash.com/photo-1585032226651-759b368d7246'],
      ['Chicken Noodles (Schezwan)', 'Noodles', 140.00, 'None', 'https://images.unsplash.com/photo-1585032226651-759b368d7246'],
      ['Chicken Keema Noodles (Normal)', 'Noodles', 119.00, 'None', 'https://images.unsplash.com/photo-1585032226651-759b368d7246'],
      ['Chicken Keema Noodles (Schezwan)', 'Noodles', 119.00, 'None', 'https://images.unsplash.com/photo-1585032226651-759b368d7246'],
      ['Prawns Fried Noodles (Normal)', 'Noodles', 139.00, 'None', 'https://images.unsplash.com/photo-1565557623262-b51c2513a641'],
      ['Prawns Fried Noodles (Schezwan)', 'Noodles', 149.00, 'None', 'https://images.unsplash.com/photo-1565557623262-b51c2513a641'],

      // MAGGIE
      ['Maggie', 'Maggi', 39.00, 'None', 'https://images.unsplash.com/photo-1612966608967-312ba599102e'],
      ['Veg Maggie', 'Maggi', 49.00, 'None', 'https://images.unsplash.com/photo-1612966608967-312ba599102e'],
      ['Egg Maggie', 'Maggi', 59.00, 'None', 'https://images.unsplash.com/photo-1612966608967-312ba599102e'],
      ['Paneer Maggie', 'Maggi', 79.00, 'None', 'https://images.unsplash.com/photo-1612966608967-312ba599102e'],
      ['Cheese Maggie', 'Maggi', 79.00, 'None', 'https://images.unsplash.com/photo-1612966608967-312ba599102e'],

      // MILK SHAKE
      ['Strawberry Shake', 'Milkshakes', 99.00, 'None', 'https://images.unsplash.com/photo-1572490122747-3968b75cc699'],
      ['Oreo Shake', 'Milkshakes', 99.00, 'None', 'https://images.unsplash.com/photo-1572490122747-3968b75cc699'],
      ['Vanilla Shake', 'Milkshakes', 79.00, 'None', 'https://images.unsplash.com/photo-1572490122747-3968b75cc699'],
      ['Chocolate Shake', 'Milkshakes', 89.00, 'None', 'https://images.unsplash.com/photo-1572490122747-3968b75cc699'],
      ['Cold Coffee', 'Milkshakes', 139.00, 'None', 'https://images.unsplash.com/photo-1572490122747-3968b75cc699'],

      // FRESH FRUIT JUICE
      ['Lemon', 'Fresh Fruit Juices', 39.00, 'None', 'https://images.unsplash.com/photo-1534422298391-e4f8c172dddb'],
      ['Watermelon', 'Fresh Fruit Juices', 49.00, 'None', 'https://images.unsplash.com/photo-1534422298391-e4f8c172dddb'],
      ['Pomegranate', 'Fresh Fruit Juices', 90.00, 'None', 'https://images.unsplash.com/photo-1534422298391-e4f8c172dddb'],
      ['Pineapple', 'Fresh Fruit Juices', 70.00, 'None', 'https://images.unsplash.com/photo-1534422298391-e4f8c172dddb'],
      ['Orange', 'Fresh Fruit Juices', 69.00, 'None', 'https://images.unsplash.com/photo-1534422298391-e4f8c172dddb'],
      ['Apple', 'Fresh Fruit Juices', 90.00, 'None', 'https://images.unsplash.com/photo-1534422298391-e4f8c172dddb'],
      ['Grapes', 'Fresh Fruit Juices', 49.00, 'None', 'https://images.unsplash.com/photo-1534422298391-e4f8c172dddb'],

      // MILK
      ['Tea', 'Milk', 15.00, 'None', 'https://images.unsplash.com/photo-1576092768241-dec231879fc3'],
      ['Coffee', 'Milk', 20.00, 'None', 'https://images.unsplash.com/photo-1509042239860-f550ce710b93'],
      ['Lemon Tea', 'Milk', 25.00, 'None', 'https://images.unsplash.com/photo-1555597673-b21d5c935865'],
      ['Sonti Tea', 'Milk', 25.00, 'None', 'https://images.unsplash.com/photo-1576092768241-dec231879fc3'],
      ['Green Tea', 'Milk', 25.00, 'None', 'https://images.unsplash.com/photo-1576092768241-dec231879fc3'],
      ['Badam Milk', 'Milk', 30.00, 'None', 'https://images.unsplash.com/photo-1576092768241-dec231879fc3'],
      ['Boost', 'Milk', 30.00, 'None', 'https://images.unsplash.com/photo-1576092768241-dec231879fc3'],
      ['Horlics', 'Milk', 30.00, 'None', 'https://images.unsplash.com/photo-1576092768241-dec231879fc3'],
      ['Ginger Tea', 'Milk', 25.00, 'None', 'https://images.unsplash.com/photo-1576092768241-dec231879fc3'],

      // FRIED CHICKEN ITEMS
      ['Chicken strips 4pcs', 'Fried Chicken Items', 99.00, 'None', 'https://images.unsplash.com/photo-1562967914-608f82629710'],
      ['Chicken wings 4pcs', 'Fried Chicken Items', 120.00, 'None', 'https://images.unsplash.com/photo-1569058242253-92a9c755a0ec'],
      ['Chicken cheesy shorts 6 pcs', 'Fried Chicken Items', 99.00, 'None', 'https://images.unsplash.com/photo-1562967914-608f82629710'],
      ['Chicken popcorn', 'Fried Chicken Items', 89.00, 'None', 'https://images.unsplash.com/photo-1562967914-608f82629710'],
      ['Chicken nuggets 8pcs', 'Fried Chicken Items', 89.00, 'None', 'https://images.unsplash.com/photo-1562967914-608f82629710'],
      ['Peri peri chicken loaded', 'Fried Chicken Items', 139.00, 'None', 'https://images.unsplash.com/photo-1562967914-608f82629710'],
      ['Fish finger 5pcs', 'Fried Chicken Items', 149.00, 'None', 'https://images.unsplash.com/photo-1569058242253-92a9c755a0ec'],
      ['Krunchy Fried chicken 1pc', 'Fried Chicken Items', 60.00, 'None', 'https://images.unsplash.com/photo-1562967914-608f82629710'],
      ['Krunchy Fried chicken 2pc', 'Fried Chicken Items', 110.00, 'None', 'https://images.unsplash.com/photo-1562967914-608f82629710'],
      ['Krunchy fried chicken bucket 12pcs', 'Fried Chicken Items', 669.00, 'None', 'https://images.unsplash.com/photo-1562967914-608f82629710'],

      // FRUIT BOWLS
      ['Classic Fruit Bowl', 'Fruit Bowls', 55.00, 'None', 'https://images.unsplash.com/photo-1519996521430-02b798c1d881'],
      ['Premium Fruit Bowl', 'Fruit Bowls', 99.00, 'None', 'https://images.unsplash.com/photo-1519996521430-02b798c1d881'],
      ['Fruit Bowl with ICE Cream', 'Fruit Bowls', 79.00, 'None', 'https://images.unsplash.com/photo-1519996521430-02b798c1d881'],
      ['Premium Fruit Bowl with ICE cream Nuts', 'Fruit Bowls', 119.00, 'None', 'https://images.unsplash.com/photo-1519996521430-02b798c1d881'],

      // SAMOSA
      ['Corn Somosa ( 4 Pices)', 'Samosa', 59.00, 'None', 'https://images.unsplash.com/photo-1601050690597-df056fb4ce78'],
      ['Paneer Somosa (4 Pices)', 'Samosa', 69.00, 'None', 'https://images.unsplash.com/photo-1601050690597-df056fb4ce78'],
      ['Chicken Somosa ( 4 Pices)', 'Samosa', 69.00, 'None', 'https://images.unsplash.com/photo-1601050690597-df056fb4ce78'],

      // SANDWICH
      ['Paneer Sandwich', 'Sandwich', 69.00, 'None', 'https://images.unsplash.com/photo-1509722747041-616f39b57569'],
      ['Veg Sandwich', 'Sandwich', 59.00, 'None', 'https://images.unsplash.com/photo-1509722747041-616f39b57569'],
      ['Mixed Veg Sandwich', 'Sandwich', 69.00, 'None', 'https://images.unsplash.com/photo-1509722747041-616f39b57569'],
      ['Mushroom Sandwich', 'Sandwich', 89.00, 'None', 'https://images.unsplash.com/photo-1509722747041-616f39b57569'],
      ['Cheesy Chicken Sandwich', 'Sandwich', 139.00, 'None', 'https://images.unsplash.com/photo-1509722747041-616f39b57569'],
      ['Tandoori Chicken Sandwich', 'Sandwich', 99.00, 'None', 'https://images.unsplash.com/photo-1509722747041-616f39b57569'],
      ['Peri Peri Chicken Sandwich', 'Sandwich', 99.00, 'None', 'https://images.unsplash.com/photo-1509722747041-616f39b57569'],
      ['Crispy Chicken Sandwich', 'Sandwich', 99.00, 'None', 'https://images.unsplash.com/photo-1509722747041-616f39b57569'],

      // Test suite required items (for public_orders_test.js and room_service_test.js compatibility)
      ['Veg Biryani', 'Biryani', 250.00, 'None', 'images/veg_biryani.png'],
      ['Tomato Soup', 'Soups', 120.00, 'None', 'https://images.pexels.com/photos/539451/pexels-photo-539451.jpeg'],
      ['Gulab Jamun', 'Desserts', 90.00, 'None', 'https://i.pinimg.com/736x/30/6e/ac/306eac21d95c385ed486ea5da524b8a5.jpg']
    ];

    for (let item of items) {
      await dbQuery.run(
        'INSERT INTO menu_items (name, category, price, dietary_tags, image_url) VALUES (?, ?, ?, ?, ?)',
        item
      );
    }
    console.log('Seeded menu items successfully.');
  }

  // Seed Admin user if empty
  const userCount = await dbQuery.get('SELECT COUNT(*) as count FROM users');
  if (userCount.count === 0) {
    const passwordHash = crypto.createHash('sha256').update('admin123').digest('hex');
    await dbQuery.run(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
      ['admin', passwordHash, 'admin']
    );
    console.log('Seeded default admin user successfully.');
  }

  // Seed default admin in admins table if empty
  const adminCount = await dbQuery.get('SELECT COUNT(*) as count FROM admins');
  if (adminCount.count === 0) {
    const passwordHash = crypto.createHash('sha256').update('admin123').digest('hex');
    await dbQuery.run(
      'INSERT INTO admins (full_name, email, username, password_hash, role, status) VALUES (?, ?, ?, ?, ?, ?)',
      ['Default Admin', 'admin@auracafe.com', 'admin', passwordHash, 'Super Admin', 'Active']
    );
    console.log('Seeded default Super Admin user successfully.');
  }

  // Seed some initial bookings ONLY in test environment to make test suite pass
  if (process.env.NODE_ENV === 'test') {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;

    const bookingsCount = await dbQuery.get('SELECT COUNT(*) as count FROM hotel_restaurant_table_booking_menu');
    if (bookingsCount.count === 0) {
      const sampleBookings = [
        ['Rajesh Kumar', 'Hotel Guest', '302', 3, '2026-06-08', '19:30', 4, 'None', 'Active'],
        ['Sarah Jenkins', 'Walk-in', null, 5, '2026-06-08', '20:00', 2, 'None', 'Active'],
        ['Amit Sharma', 'Hotel Guest', '104', 1, '2026-06-08', '13:00', 3, 'None', 'Completed'],
        ['Priya Patel', 'Walk-in', null, 8, '2026-06-09', '18:00', 6, 'None', 'Active'],
        ['David Miller', 'Hotel Guest', '405', 2, '2026-06-07', '21:00', 2, 'None', 'Completed'],
        ['Ananya Rao', 'Hotel Guest', '212', 4, '2026-06-08', '19:00', 5, 'None', 'Active'],
        ['John Doe', 'Walk-in', null, 9, '2026-06-08', '12:30', 4, 'None', 'Cancelled'],
        ['Vikram Singh', 'Hotel Guest', '308', 7, '2026-06-08', '20:30', 2, 'None', 'Active'],
        ['Emily Watson', 'Walk-in', null, 10, '2026-06-08', '21:00', 8, 'None', 'Active'],
        ['Karan Johar', 'Walk-in', null, 6, yesterdayStr, '19:00', 4, 'None', 'Completed'],
        ['Emily Watson Yesterday', 'Hotel Guest', '204', null, yesterdayStr, '20:30', 2, 'None', 'Completed']
      ];

      for (let b of sampleBookings) {
        const result = await dbQuery.run(
          `INSERT INTO hotel_restaurant_table_booking_menu 
           (guest_name, guest_type, room_number, table_number, booking_date, booking_time, guest_count, dietary_preference, status) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          b
        );
        
        const bookingId = result.id;
        
        // Add a payment record
        await dbQuery.run(
          `INSERT INTO payments (booking_id, payment_method, subtotal, discount, tax, total_amount, status) 
           VALUES (?, 'Unpaid', 0, 0, 0, 0, 'Unpaid')`,
          [bookingId]
        );

        // For completed ones, add some orders and pay them
        if (b[8] === 'Completed') {
          // Add orders
          let ordersList = [];
          if (b[0] === 'Amit Sharma') {
            ordersList = [
              ['Paneer Butter Masala', 'Main Course (Veg)', 280.00, 2, 'None'],
              ['Jeera Rice', 'Main Course (Veg)', 180.00, 1, 'None']
            ];
          } else if (b[0] === 'David Miller') {
            ordersList = [
              ['Veg Biryani', 'Main Course (Veg)', 250.00, 2, 'None'],
              ['Kaddu Ki Kheer', 'Desserts', 120.00, 2, 'None']
            ];
          } else if (b[0] === 'Karan Johar') {
            ordersList = [
              ['Chicken 65', 'Starters', 250.00, 2, 'None'],
              ['Chicken Biryani', 'Main Course (Non-Veg)', 320.00, 2, 'None'],
              ['Jeera Rice', 'Main Course (Veg)', 180.00, 1, 'None']
            ];
          } else if (b[0] === 'Emily Watson Yesterday') {
            ordersList = [
              ['Veg Manchuria', 'Starters', 180.00, 1, 'None'],
              ['Paneer Butter Masala', 'Main Course (Veg)', 280.00, 1, 'None'],
              ['Jeera Rice', 'Main Course (Veg)', 180.00, 1, 'None'],
              ['Brownie with Ice Cream', 'Desserts', 180.00, 2, 'None']
            ];
          }

          let subtotal = 0;
          for (let ord of ordersList) {
            await dbQuery.run(
              `INSERT INTO orders (booking_id, item_name, category, price, quantity, dietary_tags, status) 
               VALUES (?, ?, ?, ?, ?, ?, 'Served')`,
              [bookingId, ord[0], ord[1], ord[2], ord[3], ord[4]]
            );
            subtotal += ord[2] * ord[3];
          }

          // Update payment
          const discount = b[1] === 'Hotel Guest' ? subtotal * 0.10 : 0.0;
          const tax = (subtotal - discount) * 0.05; // 5% tax
          const total = subtotal - discount + tax;

          await dbQuery.run(
            `UPDATE payments 
             SET payment_method = ?, subtotal = ?, discount = ?, tax = ?, total_amount = ?, status = 'Paid', payment_date = ? 
             WHERE booking_id = ?`,
            [b[1] === 'Hotel Guest' ? 'Room Charge' : 'Card', subtotal, discount, tax, total, b[4], bookingId]
          );
        }
      }
      console.log('Seeded sample bookings and payments successfully in test environment.');
    }
  }



  // Self-heal: Automatically complete any bookings that are paid but marked as Active, and sync payment_status
  await dbQuery.run(`
    UPDATE hotel_restaurant_table_booking_menu 
    SET payment_status = 'paid'
    WHERE id IN (SELECT booking_id FROM payments WHERE status = 'Paid')
  `);

  await dbQuery.run(`
    UPDATE hotel_restaurant_table_booking_menu 
    SET status = 'Completed', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'Active' AND id IN (SELECT booking_id FROM payments WHERE status = 'Paid')
  `);

  // Self-heal: Create default payments for any orphan bookings
  await dbQuery.run(`
    INSERT INTO payments (booking_id, payment_method, subtotal, discount, tax, total_amount, status)
    SELECT id, 'Unpaid', 0.0, 0.0, 0.0, 0.0, 'Unpaid'
    FROM hotel_restaurant_table_booking_menu
    WHERE id NOT IN (SELECT booking_id FROM payments)
  `);

  // Incremental seed check for new items (ensures existing Turso databases get the updates)
  const newMenuItems = [
    // MILK
    ['Tea', 'Milk', 15.00, 'None', 'https://images.unsplash.com/photo-1576092768241-dec231879fc3'],
    ['Coffee', 'Milk', 20.00, 'None', 'https://images.unsplash.com/photo-1509042239860-f550ce710b93'],
    ['Lemon Tea', 'Milk', 25.00, 'None', 'https://images.unsplash.com/photo-1555597673-b21d5c935865'],
    ['Sonti Tea', 'Milk', 25.00, 'None', 'https://images.unsplash.com/photo-1576092768241-dec231879fc3'],
    ['Green Tea', 'Milk', 25.00, 'None', 'https://images.unsplash.com/photo-1576092768241-dec231879fc3'],
    ['Badam Milk', 'Milk', 30.00, 'None', 'https://images.unsplash.com/photo-1576092768241-dec231879fc3'],
    ['Boost', 'Milk', 30.00, 'None', 'https://images.unsplash.com/photo-1576092768241-dec231879fc3'],
    ['Horlics', 'Milk', 30.00, 'None', 'https://images.unsplash.com/photo-1576092768241-dec231879fc3'],
    ['Ginger Tea', 'Milk', 25.00, 'None', 'https://images.unsplash.com/photo-1576092768241-dec231879fc3'],

    // FRIED CHICKEN ITEMS
    ['Chicken strips 4pcs', 'Fried Chicken Items', 99.00, 'None', 'https://images.unsplash.com/photo-1562967914-608f82629710'],
    ['Chicken wings 4pcs', 'Fried Chicken Items', 120.00, 'None', 'https://images.unsplash.com/photo-1569058242253-92a9c755a0ec'],
    ['Chicken cheesy shorts 6 pcs', 'Fried Chicken Items', 99.00, 'None', 'https://images.unsplash.com/photo-1562967914-608f82629710'],
    ['Chicken popcorn', 'Fried Chicken Items', 89.00, 'None', 'https://images.unsplash.com/photo-1562967914-608f82629710'],
    ['Chicken nuggets 8pcs', 'Fried Chicken Items', 89.00, 'None', 'https://images.unsplash.com/photo-1562967914-608f82629710'],
    ['Peri peri chicken loaded', 'Fried Chicken Items', 139.00, 'None', 'https://images.unsplash.com/photo-1562967914-608f82629710'],
    ['Fish finger 5pcs', 'Fried Chicken Items', 149.00, 'None', 'https://images.unsplash.com/photo-1569058242253-92a9c755a0ec'],
    ['Krunchy Fried chicken 1pc', 'Fried Chicken Items', 60.00, 'None', 'https://images.unsplash.com/photo-1562967914-608f82629710'],
    ['Krunchy Fried chicken 2pc', 'Fried Chicken Items', 110.00, 'None', 'https://images.unsplash.com/photo-1562967914-608f82629710'],
    ['Krunchy fried chicken bucket 12pcs', 'Fried Chicken Items', 669.00, 'None', 'https://images.unsplash.com/photo-1562967914-608f82629710'],

    // FRUIT BOWLS
    ['Classic Fruit Bowl', 'Fruit Bowls', 55.00, 'None', 'https://images.unsplash.com/photo-1519996521430-02b798c1d881'],
    ['Premium Fruit Bowl', 'Fruit Bowls', 99.00, 'None', 'https://images.unsplash.com/photo-1519996521430-02b798c1d881'],
    ['Fruit Bowl with ICE Cream', 'Fruit Bowls', 79.00, 'None', 'https://images.unsplash.com/photo-1519996521430-02b798c1d881'],
    ['Premium Fruit Bowl with ICE cream Nuts', 'Fruit Bowls', 119.00, 'None', 'https://images.unsplash.com/photo-1519996521430-02b798c1d881'],

    // SAMOSA
    ['Corn Somosa ( 4 Pices)', 'Samosa', 59.00, 'None', 'https://images.unsplash.com/photo-1601050690597-df056fb4ce78'],
    ['Paneer Somosa (4 Pices)', 'Samosa', 69.00, 'None', 'https://images.unsplash.com/photo-1601050690597-df056fb4ce78'],
    ['Chicken Somosa ( 4 Pices)', 'Samosa', 69.00, 'None', 'https://images.unsplash.com/photo-1601050690597-df056fb4ce78'],

    // SANDWICH
    ['Paneer Sandwich', 'Sandwich', 69.00, 'None', 'https://images.unsplash.com/photo-1509722747041-616f39b57569'],
    ['Veg Sandwich', 'Sandwich', 59.00, 'None', 'https://images.unsplash.com/photo-1509722747041-616f39b57569'],
    ['Mixed Veg Sandwich', 'Sandwich', 69.00, 'None', 'https://images.unsplash.com/photo-1509722747041-616f39b57569'],
    ['Mushroom Sandwich', 'Sandwich', 89.00, 'None', 'https://images.unsplash.com/photo-1509722747041-616f39b57569'],
    ['Cheesy Chicken Sandwich', 'Sandwich', 139.00, 'None', 'https://images.unsplash.com/photo-1509722747041-616f39b57569'],
    ['Tandoori Chicken Sandwich', 'Sandwich', 99.00, 'None', 'https://images.unsplash.com/photo-1509722747041-616f39b57569'],
    ['Peri Peri Chicken Sandwich', 'Sandwich', 99.00, 'None', 'https://images.unsplash.com/photo-1509722747041-616f39b57569'],
    ['Crispy Chicken Sandwich', 'Sandwich', 99.00, 'None', 'https://images.unsplash.com/photo-1509722747041-616f39b57569']
  ];

  for (let item of newMenuItems) {
    const existing = await dbQuery.get('SELECT id FROM menu_items WHERE name = ?', [item[0]]);
    if (!existing) {
      await dbQuery.run(
        'INSERT INTO menu_items (name, category, price, dietary_tags, image_url) VALUES (?, ?, ?, ?, ?)',
        item
      );
    }
  }
  console.log('Incremental menu checks finished.');

  // Update Crispy Veg Burger image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/crispy_veg_burger.png' WHERE name = 'Crispy Veg Burger'"
  );

  // Update Veg Mini Burger 8Pic image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/veg_mini_burger_8pic.png' WHERE name = 'Veg Mini Burger 8Pic'"
  );

  // Update Chicken Mini Burger 8 Pic image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/chicken_mini_burger_8pic.png' WHERE name = 'Chicken Mini Burger 8 Pic'"
  );

  // Update Chicken Smash Burger image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/chicken_smash_burger.png' WHERE name = 'Chicken Smash Burger'"
  );

  // Update Crispy Chicken Burger image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/crispy_chicken_burger.png' WHERE name = 'Crispy Chicken Burger'"
  );

  // Update Cheese omlete image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/cheese_omlete.png' WHERE name = 'Cheese omlete'"
  );

  // Update Scrambled Egg image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/scrambled_egg.png' WHERE name = 'Scrambled Egg'"
  );

  // Update Sunny Side Up image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/sunny_side_up.png' WHERE name = 'Sunny Side Up'"
  );

  // Update Veg Fried Chees Balls image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/veg_fried_cheese_balls.png' WHERE name = 'Veg Fried Chees Balls'"
  );

  // Update Smiley Fries image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/smiley_fries.png' WHERE name = 'Smiley Fries'"
  );

  // Update Baby Corn Starter image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/crispy_baby_corn.jpg' WHERE name = 'Baby Corn Starter'"
  );

  // Update Chilli Mushroom image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/chilli_mushroom.png' WHERE name = 'Chilli Mushroom'"
  );

  // Update Chilli Paneer image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/chilli_paneer.png' WHERE name = 'Chilli Paneer'"
  );

  // Update Gobi 65 image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/gobi_65.png' WHERE name = 'Gobi 65'"
  );

  // Update Gobi Manchurian image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/gobi_manchurian.png' WHERE name = 'Gobi Manchurian'"
  );

  // Update Mushroom 65 image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/mushroom_65.png' WHERE name = 'Mushroom 65'"
  );

  // Update Paneer 65 image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/paneer_65.png' WHERE name = 'Paneer 65'"
  );

  // Update Paneer Manchurian image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/paneer_manchurian.png' WHERE name = 'Paneer Manchurian'"
  );

  // Update Chilli Chicken image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/chilli_chicken.png' WHERE name = 'Chilli Chicken'"
  );

  // Update Lemon Chicken image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/lemon_chicken.png' WHERE name = 'Lemon Chicken'"
  );

  // Update Pepper Chicken image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/pepper_chicken.png' WHERE name = 'Pepper Chicken'"
  );

  // Update Kaju Chicken image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/kaju_chicken.png' WHERE name = 'Kaju Chicken'"
  );

  // Update Juicy Lolipop image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/juicy_lolipop.png' WHERE name = 'Juicy Lolipop'"
  );

  // Update Dry Chicken image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/dry_chicken.png' WHERE name = 'Dry Chicken'"
  );

  // Update Chilly Prawns image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/chilly_prawns.png' WHERE name = 'Chilly Prawns'"
  );

  // Update Prawns 65 image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/prawns_65.png' WHERE name = 'Prawns 65'"
  );

  // Update Prawns Pepper image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/prawns_pepper.png' WHERE name = 'Prawns Pepper'"
  );

  // Update Prawns Manchurian image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/prawns_manchurian.png' WHERE name = 'Prawns Manchurian'"
  );

  // Update Veg Biryani image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/veg_biryani.png' WHERE name = 'Veg Biryani'"
  );

  // Update Chicken Fried Rice (Normal) image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/chicken_fried_rice_normal.png' WHERE name = 'Chicken Fried Rice (Normal)'"
  );

  // Update Chicken Fried Rice (Schezwan) image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/chicken_fried_rice_schezwan.png' WHERE name = 'Chicken Fried Rice (Schezwan)'"
  );

  // Update Chicken Keema Rice (Normal) image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/chicken_keema_rice_normal.png' WHERE name = 'Chicken Keema Rice (Normal)'"
  );

  // Update Chicken Keema Rice (Schezwan) image
  await dbQuery.run(
    "UPDATE menu_items SET image_url = 'images/chicken_keema_rice_schezwan.png' WHERE name = 'Chicken Keema Rice (Schezwan)'"
  );

}

function closeDb() {
  try {
    if (client && typeof client.close === 'function') {
      client.close();
    }
    return Promise.resolve();
  } catch (err) {
    return Promise.reject(err);
  }
}

module.exports = {
  db,
  dbQuery,
  initDb,
  closeDb
};
