// Demo catalog so judges see a working store immediately.
// Sellers are fictional and marked (demo). Photo credits: public/seed/CREDITS.md.
import * as store from './store.js';

const DEMO = [
  {
    title: 'Ankara Panel Tote with Silver Buckle',
    description: 'Grey woven tote with a bold Ankara swirl panel, a silver buckle strap and long double handles. Fits a laptop sleeve and daily essentials.',
    category: 'Accessories', condition: 'handmade', priceUsd: 38, floorPriceUsd: 31, stock: 4,
    tags: ['ankara', 'tote', 'bag', 'handmade', 'african print', 'gift'],
    sellerName: 'Adaeze Stitches (demo)', sellerCity: 'Lagos, Nigeria', image: '/seed/tote-buckle.jpg', swapImage: '/seed/tote-striped.jpg',
  },
  {
    title: 'Striped Woven Shopper Bag',
    description: 'Sturdy black shopper with red and gold striped woven panels and side pockets. Strong webbing handles for market days.',
    category: 'Accessories', condition: 'handmade', priceUsd: 34, floorPriceUsd: 28, stock: 5,
    tags: ['tote', 'shopper', 'bag', 'striped', 'woven', 'handmade'],
    sellerName: 'Adaeze Stitches (demo)', sellerCity: 'Lagos, Nigeria', image: '/seed/tote-striped.jpg', swapImage: '/seed/tote-buckle.jpg',
  },
  {
    title: 'Indigo Adire Cloth Panel',
    description: 'Hand-dyed indigo adire cotton cloth with resist-painted patterns. Use as a wall hanging, throw or to sew your own piece. Each panel is unique.',
    category: 'Art & Craft', condition: 'handmade', priceUsd: 65, floorPriceUsd: 55, stock: 3,
    tags: ['adire', 'indigo', 'fabric', 'textile', 'wall hanging', 'handmade', 'yoruba'],
    sellerName: 'Abeokuta Dye Works (demo)', sellerCity: 'Abeokuta, Nigeria', image: '/seed/adire-panel.jpg',
  },
  {
    title: 'Multicolour Beaded Choker Necklace',
    description: 'Handstrung choker in red, yellow, green, blue and white glass seed beads with a hanging beaded pendant. Hook clasp.',
    category: 'Accessories', condition: 'handmade', priceUsd: 45, floorPriceUsd: 36, stock: 3,
    tags: ['beads', 'necklace', 'choker', 'jewellery', 'handmade', 'gift'],
    sellerName: 'Benin Bead House (demo)', sellerCity: 'Benin City, Nigeria', image: '/seed/beaded-choker.jpg',
  },
  {
    title: 'Grey Striped Crossbody Pouch',
    description: 'Small zip pouch in grey and black striped woven fabric with a long cord strap. Holds a phone, cards and keys.',
    category: 'Accessories', condition: 'handmade', priceUsd: 18, floorPriceUsd: 15, stock: 8,
    tags: ['pouch', 'crossbody', 'bag', 'zip', 'handmade'],
    sellerName: 'Adaeze Stitches (demo)', sellerCity: 'Lagos, Nigeria', image: '/seed/crossbody.jpg',
  },
  {
    title: 'Suya Spice Mix (Yaji), 250 g',
    description: 'Ground groundnut, ginger, chilli and spice blend for suya and grilled meat. Packed in a sealed 250 g jar.',
    category: 'Food & Spices', condition: 'new', priceUsd: 12, stock: 25, negotiable: false,
    tags: ['suya', 'yaji', 'spice', 'food', 'nigerian'],
    sellerName: 'Kano Spice Corner (demo)', sellerCity: 'Kano, Nigeria', image: '/seed/yaji.jpg',
  },
];

export function seedIfEmpty() {
  if (store.listProducts({ includeHidden: true }).length) return;
  for (const p of [...DEMO].reverse()) store.addProduct({ ...p, aiModel: 'seed' });
}
