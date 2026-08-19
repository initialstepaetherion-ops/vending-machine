require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const midtransClient = require('midtrans-client');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const admin = require("firebase-admin");
// Pastikan membaca dari Environment Variable Railway
let serviceAccount;
try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
    console.error("Gagal memparsing FIREBASE_SERVICE_ACCOUNT dari environment variables!");
}
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://vending-machine-a267f-default-rtdb.asia-southeast1.firebasedatabase.app"
});

const db = admin.database();
const app = express();

let snap = new midtransClient.Snap({
    isProduction: false,
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY
});

app.use(cors());
app.use(express.json());
app.use(cookieParser());

const uploadDir = path.join(__dirname, 'public', 'uploads');
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
    const decodedToken = await admin.auth().verifyIdToken(idToken);
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
  res.sendFile(__dirname + '/public/admin.html');
});
app.get('/penjual.html', cekAksesAdmin, (req, res) => {
  res.sendFile(__dirname + '/public/penjual.html');
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('admin_session');
  res.json({ success: true });
});

app.use(express.static('public'));

app.get('/api/status', (req, res) => {
  res.send('Server Utama Vending Machine Aktif!');
});

app.get('/api/barang', async (req, res) => {
  try {
    const snapshot = await db.ref('produk/mesin_id_A1').once('value');
    res.json(snapshot.val());
  } catch (error) {
    res.status(500).json({ error: "Gagal mengambil data" });
  }
});

app.post('/api/checkout', async (req, res) => {
  const { id_slot } = req.body;
  try {
    const snapshot = await db.ref(`produk/mesin_id_A1/${id_slot}`).once('value');
    const barang = snapshot.val();
    if (barang.stok_sekarang > 0) {
      await db.ref(`produk/mesin_id_A1/${id_slot}`).update({
        stok_sekarang: barang.stok_sekarang - 1,
        terjual: barang.terjual + 1
      });
      await db.ref('kontrol_iot/mesin_id_A1').set({
        status: "MENUNGGU_MESIN",
        target_slot: id_slot
      });
      res.json({ success: true, message: "LUNAS!" });
    } else {
      res.status(400).json({ success: false, message: "Stok habis!" });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: "Gagal memproses" });
  }
});

app.post('/api/buat-transaksi', async (req, res) => {
  const { id_slot, nama_barang, harga } = req.body;
  const order_id = "LAPAK-" + id_slot + "-" + Date.now();
  let parameter = {
    "transaction_details": { "order_id": order_id, "gross_amount": harga },
    "item_details": [{ "id": id_slot, "price": harga, "quantity": 1, "name": nama_barang }]
  };
  try {
    const transaction = await snap.createTransaction(parameter);
    res.json({ success: true, token: transaction.token });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[BERHASIL] Server berjalan di http://localhost:${PORT}`);
});