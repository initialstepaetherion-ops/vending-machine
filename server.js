require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const midtransClient = require('midtrans-client');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const admin = require("firebase-admin");
const { getAuth } = require('firebase-admin/auth');
const { getDatabase } = require('firebase-admin/database');

// Gunakan environment variable di deployment, atau service account lokal saat development.
let firebaseCredentials;
let firebaseCredentialsSource;
const firebaseKeyPath = path.join(__dirname, 'firebase-key.json');
const hasFirebaseEnvironment = process.env.FIREBASE_PROJECT_ID
  && process.env.FIREBASE_CLIENT_EMAIL
  && (process.env.FIREBASE_PRIVATE_KEY || process.env.FIREBASE_PRIVATE_KEY_BASE64);

if (hasFirebaseEnvironment) {
  let firebasePrivateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (process.env.FIREBASE_PRIVATE_KEY_BASE64) {
    firebasePrivateKey = Buffer.from(process.env.FIREBASE_PRIVATE_KEY_BASE64, 'base64').toString('utf8');
  } else {
    firebasePrivateKey = firebasePrivateKey
      .trim()
      .replace(/^['"]|['"]$/g, '')
      .replace(/\\n/g, '\n');
  }

  firebaseCredentials = {
    projectId: process.env.FIREBASE_PROJECT_ID,
    privateKey: firebasePrivateKey,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL
  };
  firebaseCredentialsSource = 'environment variables';
} else if (fs.existsSync(firebaseKeyPath)) {
  firebaseCredentials = JSON.parse(fs.readFileSync(firebaseKeyPath, 'utf8'));
  firebaseCredentialsSource = 'firebase-key.json';
} else {
  throw new Error(
    'Konfigurasi Firebase tidak ditemukan. Isi FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, '
    + 'FIREBASE_PRIVATE_KEY (atau FIREBASE_PRIVATE_KEY_BASE64), atau sediakan firebase-key.json.'
  );
}

const firebaseDatabaseUrl = process.env.FIREBASE_DATABASE_URL
  || "https://vending-machine-a267f-default-rtdb.asia-southeast1.firebasedatabase.app";

admin.initializeApp({
  credential: admin.cert(firebaseCredentials),
  databaseURL: firebaseDatabaseUrl
});
console.log(`[Firebase] Admin initialized for project ${firebaseCredentials.projectId || firebaseCredentials.project_id} using ${firebaseCredentialsSource}`);

const db = getDatabase();
const auth = getAuth();
const app = express();

let snap = new midtransClient.Snap({
  isProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
  serverKey: process.env.MIDTRANS_SERVER_KEY,
  clientKey: process.env.MIDTRANS_CLIENT_KEY
});

app.use(cors());
app.use(express.json());
app.use(cookieParser());

const uploadDir = path.join(__dirname, 'Public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

app.post('/api/upload', upload.single('foto'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Tidak ada file yang diupload' });
  }
  res.json({ url: '/uploads/' + req.file.filename });
});

app.post('/api/login', async (req, res) => {
  const { idToken, email } = req.body;
  try {
    const decodedToken = await auth.verifyIdToken(idToken);
    if (decodedToken.email !== email) {
      return res.status(401).json({ success: false, error: "Email tidak cocok" });
    }

    const safeEmail = email.replace(/[.@]/g, '_');
    const whitelistRef = db.ref(`admin_whitelist/${safeEmail}`);

    whitelistRef.once('value', (snapshot) => {
      if (snapshot.exists() && snapshot.val() === true) {
        const sessionToken = jwt.sign({ email: email }, 'RAHASIA_MESIN_A1', { expiresIn: '8h' });
        res.cookie('admin_session', sessionToken, {
          httpOnly: true,
          secure: false,
          maxAge: 8 * 60 * 60 * 1000
        });
        res.json({ success: true, message: "Akses Diberikan!" });
      } else {
        res.status(403).json({ success: false, error: "Akses Ditolak!" });
      }
    });
  } catch (error) {
    res.status(401).json({ success: false, error: "Autentikasi gagal" });
  }
});

const cekAksesAdmin = (req, res, next) => {
  const token = req.cookies.admin_session;
  if (!token) {
    return res.redirect('/login.html');
  }
  try {
    jwt.verify(token, 'RAHASIA_MESIN_A1');
    next();
  } catch (error) {
    res.clearCookie('admin_session');
    return res.redirect('/login.html');
  }
};

app.get('/admin.html', cekAksesAdmin, (req, res) => {
  res.sendFile(__dirname + '/Public/admin.html');
});
app.get('/penjual.html', cekAksesAdmin, (req, res) => {
  res.sendFile(__dirname + '/Public/penjual.html');
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('admin_session');
  res.json({ success: true });
});

app.use(express.static('Public'));

app.get('/api/status', (req, res) => {
  res.send('Server Utama Vending Machine Aktif! (Versi v2 - Tes Array)');
});

app.get('/api/barang', async (req, res) => {
  try {
    const snapshot = await db.ref('produk/mesin_id_A1').once('value');
    res.json(snapshot.val());
  } catch (error) {
    res.status(500).json({ error: "Gagal mengambil data" });
  }
});

app.post(['/api/notification', '/api/payment-notification'], async (req, res) => {
  const data = req.body || {};
  const { order_id: orderId, status_code: statusCode, gross_amount: grossAmount, signature_key: signatureKey } = data;
  const serverKey = process.env.MIDTRANS_SERVER_KEY;

  if (!serverKey || typeof orderId !== 'string' || !/^LAPAK-A1-\d+$/.test(orderId)
    || typeof statusCode !== 'string' || typeof grossAmount !== 'string'
    || typeof signatureKey !== 'string') {
    return res.status(400).send('Notifikasi tidak lengkap');
  }

  const expectedSignature = crypto.createHash('sha512')
    .update(orderId + statusCode + grossAmount + serverKey)
    .digest('hex');
  const expectedBuffer = Buffer.from(expectedSignature, 'hex');
  const receivedBuffer = Buffer.from(signatureKey, 'hex');
  if (expectedBuffer.length !== receivedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)) {
    console.log('Bahaya: Ada yang mencoba memalsukan pembayaran!');
    return res.status(403).send('Akses ditolak');
  }

  const paymentSucceeded = data.transaction_status === 'settlement'
    || (data.transaction_status === 'capture' && data.fraud_status === 'accept');
  const paymentStatus = paymentSucceeded
    ? 'success'
    : ['cancel', 'deny', 'expire'].includes(data.transaction_status) ? 'failed' : 'pending';

  try {
    const orderRef = db.ref(`payment_orders/${orderId}`);
    const orderSnapshot = await orderRef.once('value');
    const order = orderSnapshot.val();
    if (!order || Number(order.gross_amount) !== Number(grossAmount)) {
      return res.status(404).send('Pesanan tidak ditemukan');
    }
    const transactionRef = db.ref(`transactions/${orderId}`);
    if (!paymentSucceeded) {
      await transactionRef.transaction((currentTransaction) => {
        if (!currentTransaction || currentTransaction.status === 'success') return;
        currentTransaction.status = paymentStatus;
        currentTransaction.updatedAt = Date.now();
        return currentTransaction;
      });
      return res.status(200).send('OK');
    }
    if (order.status === 'PROCESSED' || order.status === 'PROCESSING') {
      return res.status(200).send('OK');
    }

    const claim = await orderRef.transaction((currentOrder) => {
      if (!currentOrder || currentOrder.status !== 'PENDING') return;
      currentOrder.status = 'PROCESSING';
      return currentOrder;
    });
    if (!claim.committed) return res.status(200).send('OK');

    const productRef = db.ref('produk/mesin_id_A1');
    const inventoryUpdate = await productRef.transaction((products) => {
      if (!products || order.items.some((item) => !products[item.id_slot]
        || Number(products[item.id_slot].stok_sekarang) < item.quantity)) return;
      for (const item of order.items) {
        products[item.id_slot].stok_sekarang = Number(products[item.id_slot].stok_sekarang) - item.quantity;
        products[item.id_slot].terjual = Number(products[item.id_slot].terjual || 0) + item.quantity;
      }
      return products;
    });
    if (!inventoryUpdate.committed) {
      await orderRef.update({ status: 'STOCK_ERROR' });
      console.error(`Stok tidak mencukupi untuk pesanan ${orderId}`);
      return res.status(500).send('Stok pesanan perlu diperiksa');
    }

    await transactionRef.update({ status: 'success', updatedAt: Date.now() });
    await orderRef.update({ status: 'PROCESSED', processed_at: Date.now() });
    console.log(`Pembayaran terverifikasi untuk Order ID: ${orderId}; status transaksi diperbarui.`);
    return res.status(200).send('OK');
  } catch (error) {
    console.error('Gagal memproses notifikasi pembayaran:', error);
    return res.status(500).send('Gagal memproses notifikasi');
  }
});

app.post(['/api/create-transaction', '/api/buat-transaksi'], async (req, res) => {
  try {
    const requestedItems = Array.isArray(req.body.items)
      ? req.body.items
      : [{ id_slot: req.body.id_slot, quantity: 1 }];
    const productSnapshot = await db.ref('produk/mesin_id_A1').once('value');
    const products = productSnapshot.val() || {};
    const items = requestedItems.map((item) => {
      const idSlot = String(item.id_slot || '');
      const product = products[idSlot];
      const quantity = Number(item.quantity || 1);
      if (!/^slot_[1-4]$/.test(idSlot) || !product || !Number.isInteger(quantity) || quantity < 1
        || Number(product.stok_sekarang) < quantity) return null;
      return {
        id: idSlot,
        price: Number(product.harga),
        quantity,
        name: String(product.nama_barang || idSlot).slice(0, 50)
      };
    });

    if (!items.length || items.some((item) => !item)) {
      return res.status(400).json({ success: false, error: 'Barang tidak tersedia atau stok tidak mencukupi' });
    }

    const grossAmount = items.reduce((total, item) => total + item.price * item.quantity, 0);
    const order_id = "LAPAK-A1-" + Date.now();
    const parameter = {
      transaction_details: { order_id, gross_amount: grossAmount },
      item_details: items
    };
    const transaction = await snap.createTransaction(parameter);
    const storedItems = items.map((item) => ({ id_slot: item.id, quantity: item.quantity }));
    await Promise.all([
      db.ref(`payment_orders/${order_id}`).set({
        status: 'PENDING',
        gross_amount: grossAmount,
        items: storedItems
      }),
      db.ref(`transactions/${order_id}`).set({
        amount: grossAmount,
        status: 'pending',
        dispensed: false,
        items: storedItems,
        createdAt: Date.now()
      })
    ]);
    res.json({
      success: true,
      status: 'success',
      token: transaction.token,
      redirect_url: transaction.redirect_url,
      order_id
    });
  } catch (error) {
    res.status(500).json({ success: false, error: "Gagal memanggil Midtrans" });
  }
});

app.post('/api/update-barang', async (req, res) => {
  const { id_slot, nama_barang, harga, stok_sekarang, foto_url } = req.body;
  try {
    await db.ref(`produk/mesin_id_A1/${id_slot}`).update({
      nama_barang: nama_barang,
      harga: parseInt(harga),
      stok_sekarang: parseInt(stok_sekarang),
      foto_url: foto_url
    });
    res.json({ success: true, message: "Berhasil diperbarui!" });
  } catch (error) {
    res.status(500).json({ success: false, error: "Gagal memperbarui" });
  }
});

app.post('/api/reset-slot', async (req, res) => {
  const { id_slot } = req.body;
  try {
    await db.ref(`produk/mesin_id_A1/${id_slot}`).set({
      nama_barang: "Lapak Kosong",
      harga: 0,
      stok_sekarang: 0,
      terjual: 0,
      foto_url: "https://via.placeholder.com/300x200?text=Lapak+Kosong"
    });
    res.json({ success: true, message: `Lapak ${id_slot} dibersihkan!` });
  } catch (error) {
    res.status(500).json({ success: false, error: "Gagal mereset" });
  }
});

// Perbaikan utama di sini: Menggunakan process.env.PORT agar kompatibel dengan Railway
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server Lapak Mini A1 berjalan di port ${PORT}`);
});