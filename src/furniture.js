// Average volumes for a removals survey. cuFt = cubic feet, m3 = cubic metres, kg = estimated weight.
export const FURNITURE = [
  // ── Hallway ──
  { id: "hall-console-table", room: "Hallway", name: "Console / Hall Table", cuFt: 15.0, m3: 0.425, kg: 20 },
  { id: "hall-coat-rack", room: "Hallway", name: "Coat Rack / Stand", cuFt: 8.0, m3: 0.227, kg: 8 },
  { id: "hall-shoe-rack", room: "Hallway", name: "Shoe Rack / Cabinet", cuFt: 10.0, m3: 0.283, kg: 12 },
  { id: "hall-mirror", room: "Hallway", name: "Hall Mirror", cuFt: 8.0, m3: 0.227, kg: 12 },
  { id: "hall-grandfather-clock", room: "Hallway", name: "Grandfather Clock", cuFt: 25.0, m3: 0.708, kg: 40 },
  { id: "hall-telephone-table", room: "Hallway", name: "Telephone Table", cuFt: 6.0, m3: 0.17, kg: 8 },

  // ── Lounge / Living Room ──
  { id: "lounge-3-seater-sofa-0", room: "Lounge / Living Room", name: "3-Seater Sofa", cuFt: 50.0, m3: 1.416, kg: 45 },
  { id: "lounge-2-seater-sofa-1", room: "Lounge / Living Room", name: "2-Seater Sofa", cuFt: 35.0, m3: 0.991, kg: 35 },
  { id: "lounge-armchair-2", room: "Lounge / Living Room", name: "Armchair", cuFt: 15.0, m3: 0.425, kg: 20 },
  { id: "lounge-recliner-chair-3", room: "Lounge / Living Room", name: "Recliner Chair", cuFt: 20.0, m3: 0.566, kg: 35 },
  { id: "lounge-corner-sofa-se-4", room: "Lounge / Living Room", name: "Corner Sofa / Sectional", cuFt: 90.0, m3: 2.549, kg: 80 },
  { id: "lounge-coffee-table-5", room: "Lounge / Living Room", name: "Coffee Table", cuFt: 10.0, m3: 0.283, kg: 12 },
  { id: "lounge-side-table-6", room: "Lounge / Living Room", name: "Side Table", cuFt: 5.0, m3: 0.142, kg: 6 },
  { id: "lounge-tv-unit-stand-7", room: "Lounge / Living Room", name: "TV Unit / Stand", cuFt: 15.0, m3: 0.425, kg: 20 },
  { id: "lounge-television-up--8", room: "Lounge / Living Room", name: "Television (up to 50\")", cuFt: 8.0, m3: 0.227, kg: 12 },
  { id: "lounge-television-ove-9", room: "Lounge / Living Room", name: "Television (over 50\")", cuFt: 14.0, m3: 0.396, kg: 20 },
  { id: "lounge-bookshelf-larg-10", room: "Lounge / Living Room", name: "Bookshelf (large)", cuFt: 25.0, m3: 0.708, kg: 30 },
  { id: "lounge-bookshelf-smal-11", room: "Lounge / Living Room", name: "Bookshelf (small)", cuFt: 12.0, m3: 0.34, kg: 15 },
  { id: "lounge-display-cabine-12", room: "Lounge / Living Room", name: "Display Cabinet", cuFt: 30.0, m3: 0.85, kg: 40 },
  { id: "lounge-floor-lamp-13", room: "Lounge / Living Room", name: "Floor Lamp", cuFt: 5.0, m3: 0.142, kg: 5 },
  { id: "lounge-rug-rolled-14", room: "Lounge / Living Room", name: "Rug (rolled)", cuFt: 5.0, m3: 0.142, kg: 8 },
  { id: "lounge-piano-upright-15", room: "Lounge / Living Room", name: "Piano (upright)", cuFt: 70.0, m3: 1.982, kg: 200 },

  // ── Dining Room ──
  { id: "dining-dining-table-l-16", room: "Dining Room", name: "Dining Table (large)", cuFt: 30.0, m3: 0.85, kg: 40 },
  { id: "dining-dining-table-s-17", room: "Dining Room", name: "Dining Table (small)", cuFt: 20.0, m3: 0.566, kg: 25 },
  { id: "dining-dining-chair-18", room: "Dining Room", name: "Dining Chair", cuFt: 6.0, m3: 0.17, kg: 6 },
  { id: "dining-sideboard-buff-19", room: "Dining Room", name: "Sideboard / Buffet", cuFt: 30.0, m3: 0.85, kg: 45 },
  { id: "dining-dresser-welsh--20", room: "Dining Room", name: "Dresser / Welsh Dresser", cuFt: 40.0, m3: 1.133, kg: 55 },
  { id: "dining-drinks-cabinet-21", room: "Dining Room", name: "Drinks Cabinet", cuFt: 20.0, m3: 0.566, kg: 25 },

  // ── Conservatory ──
  { id: "cons-sofa", room: "Conservatory", name: "Conservatory Sofa", cuFt: 35.0, m3: 0.991, kg: 35 },
  { id: "cons-armchair", room: "Conservatory", name: "Conservatory Armchair", cuFt: 15.0, m3: 0.425, kg: 18 },
  { id: "cons-cane-chair", room: "Conservatory", name: "Cane / Rattan Chair", cuFt: 10.0, m3: 0.283, kg: 10 },
  { id: "cons-table", room: "Conservatory", name: "Conservatory Table", cuFt: 20.0, m3: 0.566, kg: 25 },
  { id: "cons-coffee-table", room: "Conservatory", name: "Coffee Table", cuFt: 10.0, m3: 0.283, kg: 12 },
  { id: "cons-blinds", room: "Conservatory", name: "Blinds (bundle)", cuFt: 4.0, m3: 0.113, kg: 5 },

  // ── Kitchen ──
  { id: "kitche-fridge-freezer-22", room: "Kitchen", name: "Fridge / Freezer (tall)", cuFt: 35.0, m3: 0.991, kg: 70 },
  { id: "kitche-fridge-under-c-23", room: "Kitchen", name: "Fridge (under-counter)", cuFt: 12.0, m3: 0.34, kg: 30 },
  { id: "kitche-washing-machin-24", room: "Kitchen", name: "Washing Machine", cuFt: 12.0, m3: 0.34, kg: 70 },
  { id: "kitche-tumble-dryer-25", room: "Kitchen", name: "Tumble Dryer", cuFt: 12.0, m3: 0.34, kg: 35 },
  { id: "kitche-dishwasher-26", room: "Kitchen", name: "Dishwasher", cuFt: 12.0, m3: 0.34, kg: 45 },
  { id: "kitche-cooker-oven-fr-27", room: "Kitchen", name: "Cooker / Oven (freestanding)", cuFt: 18.0, m3: 0.51, kg: 55 },
  { id: "kitche-microwave-28", room: "Kitchen", name: "Microwave", cuFt: 4.0, m3: 0.113, kg: 12 },
  { id: "kitche-kitchen-table-29", room: "Kitchen", name: "Kitchen Table", cuFt: 18.0, m3: 0.51, kg: 22 },
  { id: "kitche-kitchen-stool-30", room: "Kitchen", name: "Kitchen Stool", cuFt: 4.0, m3: 0.113, kg: 4 },
  { id: "kitche-small-applianc-31", room: "Kitchen", name: "Small Appliance (each)", cuFt: 2.0, m3: 0.057, kg: 5 },

  // ── Play Room ──
  { id: "play-toy-storage", room: "Play Room", name: "Toy Storage Unit", cuFt: 20.0, m3: 0.566, kg: 25 },
  { id: "play-toy-box", room: "Play Room", name: "Toy Box / Chest", cuFt: 12.0, m3: 0.34, kg: 15 },
  { id: "play-childrens-table", room: "Play Room", name: "Children's Table", cuFt: 10.0, m3: 0.283, kg: 12 },
  { id: "play-childrens-chair", room: "Play Room", name: "Children's Chair", cuFt: 4.0, m3: 0.113, kg: 4 },
  { id: "play-bean-bag", room: "Play Room", name: "Bean Bag", cuFt: 8.0, m3: 0.227, kg: 5 },
  { id: "play-large-toy", room: "Play Room", name: "Dolls House / Large Toy", cuFt: 10.0, m3: 0.283, kg: 12 },

  // ── Study / Office ──
  { id: "study--desk-45", room: "Study / Office", name: "Desk", cuFt: 20.0, m3: 0.566, kg: 25 },
  { id: "study--office-chair-46", room: "Study / Office", name: "Office Chair", cuFt: 10.0, m3: 0.283, kg: 12 },
  { id: "study--filing-cabinet-47", room: "Study / Office", name: "Filing Cabinet", cuFt: 12.0, m3: 0.34, kg: 25 },
  { id: "study--computer-monit-48", room: "Study / Office", name: "Computer / Monitor", cuFt: 4.0, m3: 0.113, kg: 8 },
  { id: "study--bookcase-49", room: "Study / Office", name: "Bookcase", cuFt: 20.0, m3: 0.566, kg: 25 },

  // ── Bedroom ──
  { id: "bedroo-double-bed-fra-32", room: "Bedroom", name: "Double Bed (frame)", cuFt: 40.0, m3: 1.133, kg: 50 },
  { id: "bedroo-single-bed-fra-33", room: "Bedroom", name: "Single Bed (frame)", cuFt: 25.0, m3: 0.708, kg: 30 },
  { id: "bedroo-king-size-bed--34", room: "Bedroom", name: "King Size Bed (frame)", cuFt: 50.0, m3: 1.416, kg: 60 },
  { id: "bedroo-double-mattres-35", room: "Bedroom", name: "Double Mattress", cuFt: 30.0, m3: 0.85, kg: 25 },
  { id: "bedroo-single-mattres-36", room: "Bedroom", name: "Single Mattress", cuFt: 18.0, m3: 0.51, kg: 15 },
  { id: "bedroo-king-mattress-37", room: "Bedroom", name: "King Mattress", cuFt: 40.0, m3: 1.133, kg: 35 },
  { id: "bedroo-wardrobe-doubl-38", room: "Bedroom", name: "Wardrobe (double)", cuFt: 50.0, m3: 1.416, kg: 60 },
  { id: "bedroo-wardrobe-singl-39", room: "Bedroom", name: "Wardrobe (single)", cuFt: 30.0, m3: 0.85, kg: 40 },
  { id: "bedroo-chest-of-drawe-40", room: "Bedroom", name: "Chest of Drawers", cuFt: 20.0, m3: 0.566, kg: 30 },
  { id: "bedroo-bedside-table-41", room: "Bedroom", name: "Bedside Table", cuFt: 5.0, m3: 0.142, kg: 8 },
  { id: "bedroo-dressing-table-42", room: "Bedroom", name: "Dressing Table", cuFt: 20.0, m3: 0.566, kg: 25 },
  { id: "bedroo-blanket-box-ot-43", room: "Bedroom", name: "Blanket Box / Ottoman", cuFt: 12.0, m3: 0.34, kg: 15 },
  { id: "bedroo-mirror-freesta-44", room: "Bedroom", name: "Mirror (freestanding)", cuFt: 8.0, m3: 0.227, kg: 12 },

  // ── Bathroom ──
  { id: "bathro-bathroom-cabin-50", room: "Bathroom", name: "Bathroom Cabinet", cuFt: 8.0, m3: 0.227, kg: 12 },
  { id: "bathro-laundry-basket-51", room: "Bathroom", name: "Laundry Basket", cuFt: 4.0, m3: 0.113, kg: 3 },
  { id: "bathro-towel-rail-fre-52", room: "Bathroom", name: "Towel Rail (freestanding)", cuFt: 4.0, m3: 0.113, kg: 5 },

  // ── Loft ──
  { id: "loft-suitcase", room: "Loft", name: "Suitcase", cuFt: 5.0, m3: 0.142, kg: 8 },
  { id: "loft-storage-crate", room: "Loft", name: "Storage Crate", cuFt: 4.0, m3: 0.113, kg: 10 },
  { id: "loft-xmas-box", room: "Loft", name: "Christmas Decorations Box", cuFt: 4.0, m3: 0.113, kg: 8 },
  { id: "loft-water-tank", room: "Loft", name: "Water Tank", cuFt: 20.0, m3: 0.566, kg: 25 },
  { id: "loft-stored-furniture", room: "Loft", name: "Stored Furniture (item)", cuFt: 20.0, m3: 0.566, kg: 25 },

  // ── Garage ──
  { id: "garage-bicycle-57", room: "Garage", name: "Bicycle", cuFt: 10.0, m3: 0.283, kg: 15 },
  { id: "garage-tool-chest-58", room: "Garage", name: "Tool Chest", cuFt: 15.0, m3: 0.425, kg: 50 },
  { id: "garage-workbench-59", room: "Garage", name: "Workbench", cuFt: 25.0, m3: 0.708, kg: 40 },
  { id: "garage-ladder-60", room: "Garage", name: "Ladder", cuFt: 8.0, m3: 0.227, kg: 12 },
  { id: "garage-shelving", room: "Garage", name: "Shelving Unit", cuFt: 20.0, m3: 0.566, kg: 25 },
  { id: "garage-freezer", room: "Garage", name: "Chest Freezer", cuFt: 25.0, m3: 0.708, kg: 55 },

  // ── Garden ──
  { id: "garden-lawn-mower-53", room: "Garden", name: "Lawn Mower", cuFt: 12.0, m3: 0.34, kg: 30 },
  { id: "garden-table-54", room: "Garden", name: "Garden Table", cuFt: 20.0, m3: 0.566, kg: 25 },
  { id: "garden-chair-55", room: "Garden", name: "Garden Chair", cuFt: 6.0, m3: 0.17, kg: 6 },
  { id: "garden-bench", room: "Garden", name: "Garden Bench", cuFt: 18.0, m3: 0.51, kg: 30 },
  { id: "garden-bbq-56", room: "Garden", name: "BBQ", cuFt: 15.0, m3: 0.425, kg: 30 },
  { id: "garden-parasol", room: "Garden", name: "Parasol / Umbrella", cuFt: 8.0, m3: 0.227, kg: 10 },
  { id: "garden-plant-pot-larg-61", room: "Garden", name: "Plant Pot (large)", cuFt: 6.0, m3: 0.17, kg: 15 },

  // ── Green House ──
  { id: "green-staging", room: "Green House", name: "Plant Staging / Shelving", cuFt: 15.0, m3: 0.425, kg: 20 },
  { id: "green-pots", room: "Green House", name: "Plant Pots (bundle)", cuFt: 6.0, m3: 0.17, kg: 15 },
  { id: "green-trays", room: "Green House", name: "Grow Bags / Seed Trays", cuFt: 5.0, m3: 0.142, kg: 8 },
  { id: "green-tools", room: "Green House", name: "Garden Tools (bundle)", cuFt: 6.0, m3: 0.17, kg: 12 },
  { id: "green-watering-can", room: "Green House", name: "Watering Can", cuFt: 3.0, m3: 0.085, kg: 3 },
];

// Box / carton options. These appear inside EVERY room. The wardrobe box is
// restricted (in App.jsx) to bedrooms and the hallway only.
export const BOX_ITEMS = [
  { id: "box-tea-chest", name: "Tea Chest Box (large)", cuFt: 6.0, m3: 0.17, kg: 18 },
  { id: "box-standard", name: "Standard Box (medium)", cuFt: 3.0, m3: 0.085, kg: 10 },
  { id: "box-book", name: "Book Box (small)", cuFt: 2.0, m3: 0.057, kg: 12 },
  { id: "box-picture", name: "Picture / Mirror Box", cuFt: 3.0, m3: 0.085, kg: 8 },
  { id: "box-wardrobe", name: "Wardrobe Box", cuFt: 12.0, m3: 0.34, kg: 18 },
];
export const WARDROBE_BOX_ID = "box-wardrobe";

export const ROOMS = [
  "Hallway",
  "Lounge / Living Room",
  "Dining Room",
  "Conservatory",
  "Kitchen",
  "Play Room",
  "Study / Office",
  "Bedroom",
  "Bathroom",
  "Loft",
  "Garage",
  "Garden",
  "Green House",
];

// Recommended vehicle by total cubic feet (typical usable load space).
export const VAN_SIZES = [
  { name: "3.5t",  cuFt: 450 },
  { name: "7.5t",  cuFt: 1100 },
  { name: "18t",   cuFt: 2200 },
];

export function recommendVehicle(totalCuFt) {
  if (!totalCuFt) return { vehicle: "—", loads: 0 };
  for (const v of VAN_SIZES) {
    if (totalCuFt <= v.cuFt) return { vehicle: v.name, loads: 1 };
  }
  const biggest = VAN_SIZES[VAN_SIZES.length - 1];
  const loads = Math.ceil(totalCuFt / biggest.cuFt);
  return { vehicle: biggest.name, loads };
}
