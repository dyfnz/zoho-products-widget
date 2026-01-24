/**
 * Distributor Product Lookup Widget
 * For Zoho CRM Quotes module integration
 * Updated: December 2025 - UI Redesign v2
 */

// =====================================================
// CONFIGURATION
// =====================================================
const PROXY_BASE = 'https://tydxdpntshbobomemzxj.supabase.co/functions/v1/ingram-proxy';
const TDSYNNEX_BASE = 'https://tydxdpntshbobomemzxj.supabase.co/functions/v1';
const TDSYNNEX_PROXY_BASE = 'https://tydxdpntshbobomemzxj.supabase.co/functions/v1/tdsynnex-proxy';
const SUPABASE_URL = 'https://tydxdpntshbobomemzxj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR5ZHhkcG50c2hib2JvbWVtenhqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjA4MTg0MjcsImV4cCI6MjA3NjM5NDQyN30.cVcmS7yKqAF1LBOTz0ZNgxgaEILLi7FuWX9E8eZjZac';
const PAGE_SIZE = 50;

// Distributor configurations
const DISTRIBUTORS = {
    ingram: {
        name: 'Ingram Micro',
        apiPrefix: '/api',
        color: '#0ea5e9'
    },
    tdsynnex: {
        name: 'TD SYNNEX',
        apiPrefix: '/tdsynnex',
        color: '#10b981'
    },
    arrow: {
        name: 'Arrow',
        apiPrefix: '/arrow',
        color: '#f59e0b',
        disabled: true
    }
};

// =====================================================
// STATE MANAGEMENT
// =====================================================
const state = {
    currentDistributor: 'ingram',
    // Filters
    manufacturer: '',
    category: '',
    subcategory: '',
    cat3: '',  // TD Synnex category level 3
    skuType: '',
    skuKeyword: '',
    // Filter loading state
    loadingFilters: {
        category: false,
        subcategory: false,
        cat3: false
    },
    filterParams: {
        category: '',
        subcategory: '',
        cat3: ''
    },
    // Pagination and products
    currentPage: 1,
    totalRecords: 0,
    totalPages: 1,
    selectedProducts: new Map(),
    queuedProducts: [],
    groupByManufacturer: true,
    isAuthenticated: false,
    pendingResponseId: null,
    parentContext: null,
    currentProducts: [],
    pricingData: {},
    rawApiVisible: false,
    // SKU-first search mode
    skuSearchMode: false,
    pendingSkuFilter: '',
    skuManufacturerOptions: [],
    // Manufacturer Resolution Panel State (Phase 3)
    prefetchedManufacturers: [],
    mfrResolutions: new Map(),
    unresolvedManufacturers: [],
    mfrResolutionPromise: null,
    manufacturerMappingsData: []  // Cached mappings from Supabase
};

let searchTimeout = null;
let draggedItem = null;
let draggedGroup = null;
let resizeStartY = 0;
let resizeStartHeight = 0;
let isResizing = false;
let isResizingQueue = false;
let queueResizeStartX = 0;
let queueResizeStartWidth = 0;

// =====================================================
// ZOHO SDK INITIALIZATION
// =====================================================
document.addEventListener('DOMContentLoaded', function() {
    console.log('Widget DOM loaded, initializing...');
    initZohoSDK();
    initEventListeners();
    initDragAndDrop();
    initResize();
    initQueueResize();
    checkProxyStatus();
    updateQueueUI();
    loadManufacturerMappings();
    initMfrMappingsResize();
    initMfrMappingsTooltip();

    // Set "Group by Manufacturer" checkbox to match default state
    const groupByMfrCheckbox = document.getElementById('groupByMfr');
    if (groupByMfrCheckbox) {
        groupByMfrCheckbox.checked = state.groupByManufacturer;
    }
});

function initZohoSDK() {
    if (typeof ZOHO === 'undefined') {
        console.warn('ZOHO SDK not loaded. Running in standalone mode.');
        showStatus('Running in standalone mode (Zoho SDK not available)', 'info');
        return;
    }

    ZOHO.embeddedApp.init();
    console.log('ZOHO.embeddedApp.init() called');

    ZOHO.embeddedApp.on("PageLoad", function(data) {
        console.log('PageLoad event received:', data);
        state.parentContext = data;

        // Store pre-fetched manufacturers from Client Script (Phase 3)
        if (data && data.manufacturers && Array.isArray(data.manufacturers)) {
            state.prefetchedManufacturers = data.manufacturers.map(m => {
                // Handle both {id, name} objects and plain strings
                return typeof m === 'string' ? m : (m.name || m.Name || '');
            }).filter(name => name.length > 0).sort();
            console.log(`[MfrResolution] Received ${state.prefetchedManufacturers.length} manufacturers from Zoho`);
        }

        showStatus('Widget loaded. Select a manufacturer or enter a SKU to begin.', 'info');
    });

    ZOHO.embeddedApp.on("NotifyAndWait", function(data) {
        console.log('NotifyAndWait event received:', data);
        state.pendingResponseId = data.id;
        state.parentContext = data.data || {};

        // Also check NotifyAndWait for manufacturers (might come later)
        const eventData = data.data || {};
        if (eventData.manufacturers && Array.isArray(eventData.manufacturers) && state.prefetchedManufacturers.length === 0) {
            state.prefetchedManufacturers = eventData.manufacturers.map(m => {
                return typeof m === 'string' ? m : (m.name || m.Name || '');
            }).filter(name => name.length > 0).sort();
            console.log(`[MfrResolution] Received ${state.prefetchedManufacturers.length} manufacturers from NotifyAndWait`);
        }

        showStatus('Ready to search. Select products and click "Add to Queue".', 'info');
    });
}

// =====================================================
// EVENT LISTENERS
// =====================================================
function initEventListeners() {
    const mfrSearch = document.getElementById('manufacturerSearch');
    if (mfrSearch) {
        mfrSearch.addEventListener('input', debounceManufacturerSearch);
    }

    // SKU search field (single field for both SKU-first and filter modes)
    const skuSearch = document.getElementById('skuSearch');
    if (skuSearch) {
        skuSearch.addEventListener('input', () => {
            state.skuKeyword = skuSearch.value.trim();
        });
        skuSearch.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleLoadProducts();
            }
        });
    }

    const selectAll = document.getElementById('selectAll');
    if (selectAll) {
        selectAll.addEventListener('change', toggleSelectAll);
    }
}

// =====================================================
// RESIZE FUNCTIONALITY
// =====================================================
function initResize() {
    const resizeHandle = document.getElementById('resizeHandle');
    const tableContainer = document.querySelector('.table-container');

    if (!resizeHandle || !tableContainer) return;

    resizeHandle.addEventListener('mousedown', (e) => {
        isResizing = true;
        resizeStartY = e.clientY;
        resizeStartHeight = tableContainer.offsetHeight;
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;

        const deltaY = e.clientY - resizeStartY;
        const newHeight = Math.max(100, Math.min(1250, resizeStartHeight + deltaY));
        tableContainer.style.maxHeight = newHeight + 'px';
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        }
    });
}

// =====================================================
// QUEUE PANEL HORIZONTAL RESIZE
// =====================================================
function initQueueResize() {
    const resizeHandle = document.getElementById('queueResizeHandle');
    const rightPanel = document.getElementById('rightPanel');

    if (!resizeHandle || !rightPanel) return;

    resizeHandle.addEventListener('mousedown', (e) => {
        isResizingQueue = true;
        queueResizeStartX = e.clientX;
        queueResizeStartWidth = rightPanel.offsetWidth;
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizingQueue) return;

        // Dragging left increases width, dragging right decreases
        const deltaX = queueResizeStartX - e.clientX;
        const newWidth = Math.max(240, Math.min(600, queueResizeStartWidth + deltaX));
        rightPanel.style.width = newWidth + 'px';

        // Toggle narrow class for responsive stacking
        if (newWidth < 300) {
            rightPanel.classList.add('narrow');
        } else {
            rightPanel.classList.remove('narrow');
        }
    });

    document.addEventListener('mouseup', () => {
        if (isResizingQueue) {
            isResizingQueue = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        }
    });
}

// =====================================================
// TOOLTIP POSITIONING (Fixed Position + JS)
// =====================================================
/**
 * Initialize tooltip positioning for info buttons
 * Uses position: fixed and calculates position on hover
 * Call this after dynamically rendering tooltip elements
 */
function initMfrResolutionTooltips() {
    document.querySelectorAll('.mfr-resolution-table .tooltip-wrapper').forEach(wrapper => {
        const btn = wrapper.querySelector('.info-btn');
        const tooltip = wrapper.querySelector('.tooltip');

        if (!btn || !tooltip) return;

        // Remove any existing listeners (avoid duplicates)
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);

        newBtn.addEventListener('mouseenter', (e) => {
            const rect = newBtn.getBoundingClientRect();
            // Center the 220px tooltip above the button
            tooltip.style.left = (rect.left + rect.width/2 - 110) + 'px';
            tooltip.style.top = (rect.top - tooltip.offsetHeight - 8) + 'px';
            tooltip.classList.add('visible');
        });

        newBtn.addEventListener('mouseleave', () => {
            tooltip.classList.remove('visible');
        });
    });
}

/**
 * Initialize tooltip for the manufacturer mappings button
 * Uses same pattern as mfr resolution tooltips
 */
function initMfrMappingsTooltip() {
    const wrapper = document.querySelector('.mfr-mappings-tooltip-wrapper');
    if (!wrapper) return;

    const btn = wrapper.querySelector('.mfr-mappings-btn');
    const tooltip = wrapper.querySelector('.tooltip');

    if (!btn || !tooltip) return;

    btn.addEventListener('mouseenter', (e) => {
        const rect = btn.getBoundingClientRect();
        // Position tooltip below the button (since it's in the header area)
        tooltip.style.left = (rect.left + rect.width/2 - 110) + 'px';
        tooltip.style.top = (rect.bottom + 8) + 'px';
        tooltip.classList.add('visible');
    });

    btn.addEventListener('mouseleave', () => {
        tooltip.classList.remove('visible');
    });
}

// =====================================================
// DRAG AND DROP FOR QUEUE
// =====================================================
function initDragAndDrop() {
    const queueItems = document.getElementById('queueItems');
    if (!queueItems) return;

    queueItems.addEventListener('dragstart', handleDragStart);
    queueItems.addEventListener('dragend', handleDragEnd);
    queueItems.addEventListener('dragover', handleDragOver);
    queueItems.addEventListener('drop', handleDrop);
}

function handleDragStart(e) {
    // Handle manufacturer group dragging
    if (e.target.classList.contains('queue-mfr-group')) {
        draggedGroup = e.target;
        e.target.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', 'group:' + e.target.dataset.manufacturer);
        return;
    }

    if (!e.target.classList.contains('queue-item')) return;

    draggedItem = e.target;
    e.target.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', e.target.dataset.partNumber);
}

function handleDragEnd(e) {
    if (draggedItem) {
        draggedItem.classList.remove('dragging');
        draggedItem = null;
    }
    if (draggedGroup) {
        draggedGroup.classList.remove('dragging');
        draggedGroup = null;
    }
    document.querySelectorAll('.queue-item, .queue-mfr-group').forEach(item => {
        item.classList.remove('drag-over');
    });
}

function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const queueItems = document.getElementById('queueItems');

    if (draggedGroup && state.groupByManufacturer) {
        // Handle group reordering
        const afterGroup = getDragAfterGroup(e.clientY);
        const groupWithItems = getGroupElements(draggedGroup.dataset.manufacturer);

        if (afterGroup == null) {
            // Move to end
            groupWithItems.forEach(el => queueItems.appendChild(el));
        } else {
            // Move before the target group
            const beforeEl = afterGroup;
            groupWithItems.forEach(el => queueItems.insertBefore(el, beforeEl));
        }
    } else if (draggedItem) {
        const afterElement = getDragAfterElement(e.clientY);

        if (afterElement == null) {
            queueItems.appendChild(draggedItem);
        } else {
            queueItems.insertBefore(draggedItem, afterElement);
        }
    }
}

function handleDrop(e) {
    e.preventDefault();

    if (state.groupByManufacturer && draggedGroup) {
        // Reorder by manufacturer groups
        reorderByGroups();
    } else {
        // Reorder state.queuedProducts based on new DOM order
        const newOrder = [];
        document.querySelectorAll('.queue-item').forEach(item => {
            const partNumber = item.dataset.partNumber;
            const product = state.queuedProducts.find(p =>
                (p.ingramPartNumber || p.vendorPartNumber) === partNumber
            );
            if (product) {
                newOrder.push(product);
            }
        });

        state.queuedProducts = newOrder;
        console.log('[Queue] Reordered:', state.queuedProducts.map(p => p.vendorPartNumber));
    }
}

function getDragAfterElement(y) {
    const draggableElements = [...document.querySelectorAll('.queue-item:not(.dragging)')];

    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;

        if (offset < 0 && offset > closest.offset) {
            return { offset: offset, element: child };
        } else {
            return closest;
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

function getDragAfterGroup(y) {
    const groupElements = [...document.querySelectorAll('.queue-mfr-group:not(.dragging)')];

    return groupElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;

        if (offset < 0 && offset > closest.offset) {
            return { offset: offset, element: child };
        } else {
            return closest;
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

function getGroupElements(manufacturer) {
    const elements = [];
    const groupHeader = document.querySelector(`.queue-mfr-group[data-manufacturer="${manufacturer}"]`);
    if (groupHeader) {
        elements.push(groupHeader);
        // Get all items after this header until the next header
        let sibling = groupHeader.nextElementSibling;
        while (sibling && !sibling.classList.contains('queue-mfr-group')) {
            elements.push(sibling);
            sibling = sibling.nextElementSibling;
        }
    }
    return elements;
}

function reorderByGroups() {
    // Get the new order of manufacturers from the DOM
    const mfrOrder = [];
    document.querySelectorAll('.queue-mfr-group').forEach(group => {
        mfrOrder.push(group.dataset.manufacturer);
    });

    // Reorder queuedProducts based on manufacturer order
    const newOrder = [];
    mfrOrder.forEach(mfr => {
        state.queuedProducts
            .filter(p => (p.vendorName || state.manufacturer || 'Unknown') === mfr)
            .forEach(p => newOrder.push(p));
    });

    state.queuedProducts = newOrder;
    console.log('[Queue] Reordered by groups:', mfrOrder);
}

// =====================================================
// RAW API TOGGLE
// =====================================================
function toggleRawApi() {
    state.rawApiVisible = !state.rawApiVisible;
    const container = document.getElementById('rawApiContainer');
    const toggle = document.getElementById('rawApiToggle');

    if (container && toggle) {
        container.style.display = state.rawApiVisible ? 'block' : 'none';
        toggle.classList.toggle('active', state.rawApiVisible);
    }
}

// =====================================================
// GROUP BY MANUFACTURER TOGGLE
// =====================================================
function toggleGroupByManufacturer() {
    const checkbox = document.getElementById('groupByMfr');
    state.groupByManufacturer = checkbox ? checkbox.checked : false;
    renderQueueItems();
}

// =====================================================
// DISTRIBUTOR SELECTION
// =====================================================
function selectDistributor(distributor) {
    if (DISTRIBUTORS[distributor]?.disabled) {
        showStatus(`${DISTRIBUTORS[distributor].name} integration coming soon`, 'info');
        return;
    }

    state.currentDistributor = distributor;

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.distributor === distributor);
    });

    // Clear product details when switching distributors (queue is preserved)
    hideProductDetails();

    // Show/hide distributor-specific filters
    const cat3Field = document.getElementById('cat3FilterField');
    const skuTypeField = document.getElementById('skuTypeFilterField');

    if (distributor === 'tdsynnex') {
        // TD Synnex: Show cat3, hide SKU type
        if (cat3Field) cat3Field.style.display = '';
        if (skuTypeField) skuTypeField.style.display = 'none';
    } else {
        // Ingram: Hide cat3, show SKU type
        if (cat3Field) cat3Field.style.display = 'none';
        if (skuTypeField) skuTypeField.style.display = '';
    }

    resetFilters();
    showStatus(`Switched to ${DISTRIBUTORS[distributor].name}. Search by manufacturer or SKU.`, 'info');
}

// =====================================================
// PROXY STATUS CHECK
// =====================================================
async function checkProxyStatus() {
    const indicator = document.getElementById('statusIndicator');
    const statusText = document.getElementById('statusText');

    try {
        const response = await fetch(`${PROXY_BASE}?action=status`);
        const data = await response.json();

        if (data.authenticated) {
            indicator.classList.add('connected');
            statusText.textContent = 'Connected';
            state.isAuthenticated = true;
        } else if (data.configured) {
            statusText.textContent = 'Not authenticated';
            await authenticate();
        } else {
            statusText.textContent = 'Not configured';
            showStatus('Proxy server not configured. Check credentials.', 'error');
        }
    } catch (error) {
        indicator.classList.remove('connected');
        statusText.textContent = 'Offline';
        showStatus('Cannot connect to proxy server.', 'error');
    }
}

async function authenticate() {
    try {
        const response = await fetch(`${PROXY_BASE}?action=auth`);
        const data = await response.json();

        if (data.success) {
            document.getElementById('statusIndicator').classList.add('connected');
            document.getElementById('statusText').textContent = 'Connected';
            state.isAuthenticated = true;
            showStatus('Authentication successful. Search for a manufacturer.', 'success');
        }
    } catch (error) {
        showStatus('Authentication failed: ' + error.message, 'error');
    }
}

// =====================================================
// TD SYNNEX API FUNCTIONS
// =====================================================

// TD Synnex warehouse location mapping for display
const TDSYNNEX_WAREHOUSES = {
    qty_miami_fl: { id: 'MIA', location: 'Miami, FL' },
    qty_tracy_ca: { id: 'TRC', location: 'Tracy, CA' },
    qty_romeoville_il: { id: 'ROM', location: 'Romeoville, IL' },
    qty_southaven_ms: { id: 'SHV', location: 'Southaven, MS' },
    qty_columbus_oh: { id: 'COL', location: 'Columbus, OH' },
    qty_suwanee_ga: { id: 'SUW', location: 'Suwanee, GA' },
    qty_chino_ca: { id: 'CHI', location: 'Chino, CA' },
    qty_swedesboro_nj: { id: 'SWD', location: 'Swedesboro, NJ' },
    qty_south_bend_in: { id: 'SBI', location: 'South Bend, IN' },
    qty_fort_worth_tx: { id: 'FTW', location: 'Fort Worth, TX' },
    qty_fontana_ca: { id: 'FON', location: 'Fontana, CA' }
};

// TD SYNNEX Kit/Standalone formatter
function formatKitStandalone(flag) {
    if (!flag) return '-';
    return flag.toUpperCase() === 'K' ? 'Kit' : 'Standalone';
}

// TD SYNNEX ABC Code formatter
function formatABCCode(code) {
    const defs = {
        'A': 'Active',
        'B': 'Special Order',
        'C': 'EOL',
        'T': 'To Be Discontinued'
    };
    if (!code) return '-';
    return defs[code.toUpperCase()] || code;
}

// Check if TD SYNNEX product is "New" (created within 90 days)
function isTDSynnexNew(createdDate) {
    if (!createdDate) return false;
    const created = new Date(createdDate);
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    return created >= ninetyDaysAgo;
}

// Check if TD SYNNEX product is Licensed
function isTDSynnexLicensed(assignedUse, longDescription) {
    const searchTerm = 'licens';
    const assignedMatch = assignedUse && assignedUse.toLowerCase().includes(searchTerm);
    const descMatch = longDescription && longDescription.toLowerCase().includes(searchTerm);
    return assignedMatch || descMatch;
}

// Check if TD SYNNEX product is a Service SKU
function isTDSynnexServiceSku(cat1, cat2) {
    const cat1Lower = (cat1 || '').toLowerCase();
    const cat2Lower = (cat2 || '').toLowerCase();
    return cat1Lower === 'service / support' ||
           cat2Lower.includes('service') ||
           cat2Lower.includes('support');
}

// Format YYMMDD date to MM/DD/YYYY
function formatPromoDate(yymmdd) {
    if (!yymmdd || yymmdd.length !== 6) return yymmdd || 'N/A';
    const yy = yymmdd.substring(0, 2);
    const mm = yymmdd.substring(2, 4);
    const dd = yymmdd.substring(4, 6);
    return `${mm}/${dd}/20${yy}`;
}

// Derive SKU Type from physical dimensions
function deriveSKUType(weight, length, width, height) {
    // If all dimensions are 0 or null, it's Digital
    const allZero = (weight || 0) === 0 &&
                    (length || 0) === 0 &&
                    (width || 0) === 0 &&
                    (height || 0) === 0;
    return allZero ? 'Digital' : 'Physical';
}

// Fetch warehouse availability from TD SYNNEX XML API
async function fetchTDSynnexWarehouseAvailability(synnexSKU) {
    if (!synnexSKU) return { warehouses: [], totalQty: 0, totalOnOrder: 0, status: null };
    try {
        const response = await fetch(
            `${TDSYNNEX_PROXY_BASE}?action=availability&synnexSKU=${encodeURIComponent(synnexSKU)}`
        );
        const data = await response.json();
        return {
            warehouses: data.warehouses || [],
            totalQty: data.totalQty || 0,
            totalOnOrder: data.totalOnOrder || 0,
            status: data.status || null
        };
    } catch (error) {
        console.error('[TD SYNNEX] Warehouse fetch error:', error);
        return { warehouses: [], totalQty: 0, totalOnOrder: 0, status: null };
    }
}

async function searchTDSynnexManufacturers(searchTerm) {
    const response = await fetch(
        `${TDSYNNEX_BASE}/manufacturer-lookup?search=${encodeURIComponent(searchTerm)}&limit=100`
    );
    const data = await response.json();

    if (data.success && data.data?.manufacturers) {
        return data.data.manufacturers.map(m => m.manufacturer_name);
    }
    return [];
}

async function loadTDSynnexCategories(manufacturer, cat1 = null, cat2 = null) {
    let url = `${TDSYNNEX_BASE}/category-lookup?manufacturer=${encodeURIComponent(manufacturer)}`;
    if (cat1) url += `&cat1=${encodeURIComponent(cat1)}`;
    if (cat2) url += `&cat2=${encodeURIComponent(cat2)}`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.success && data.data?.categories) {
        // Extract the appropriate description field based on level
        const level = data.data.level;
        return data.data.categories.map(c => {
            if (level === 1) return { name: c.cat_description_1, count: c.product_count };
            if (level === 2) return { name: c.cat_description_2, count: c.product_count };
            if (level === 3) return { name: c.cat_description_3, count: c.product_count };
            return { name: 'Unknown', count: 0 };
        });
    }
    return [];
}

async function searchTDSynnexProducts(manufacturer, options = {}) {
    const { search = '', cat1 = '', cat2 = '', cat3 = '', limit = PAGE_SIZE, offset = 0 } = options;

    let url = `${TDSYNNEX_BASE}/product-search?manufacturer=${encodeURIComponent(manufacturer)}`;
    url += `&limit=${limit}&offset=${offset}`;
    if (search) url += `&search=${encodeURIComponent(search)}`;
    if (cat1) url += `&cat1=${encodeURIComponent(cat1)}`;
    if (cat2) url += `&cat2=${encodeURIComponent(cat2)}`;
    if (cat3) url += `&cat3=${encodeURIComponent(cat3)}`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.success && data.data) {
        return {
            products: data.data.products.map(mapTDSynnexProduct),
            totalCount: data.data.total_count,
            pagination: {
                page: Math.floor(offset / limit) + 1,
                pageSize: limit,
                totalPages: Math.ceil(data.data.total_count / limit),
                totalRecords: data.data.total_count
            }
        };
    }
    return { products: [], totalCount: 0, pagination: null };
}

// Map TD Synnex product to widget's expected format (matching Ingram structure)
function mapTDSynnexProduct(product) {
    // Derive SKU Type from physical dimensions
    const skuType = deriveSKUType(
        product.ship_weight,
        product.length,
        product.width,
        product.height
    );

    return {
        // Core identifiers
        vendorPartNumber: product.manufacturer_part_number,
        ingramPartNumber: product.manufacturer_part_number, // Use MPN for display consistency
        distributorPartNumber: product.td_synnex_sku,
        tdSynnexSkuNumber: product.td_synnex_sku_number, // Numeric SKU for API calls (Field 5)

        // Product info
        description: product.part_description,
        vendorName: product.manufacturer_name,
        category: product.cat_description_1,
        subCategory: product.cat_description_2,
        cat3: product.cat_description_3,

        // Extended description
        extraDescription: product.long_description || product.long_description_1 || '',

        // Pricing (TD Synnex has msrp directly)
        retailPrice: product.msrp,
        unitCost: product.unit_cost,
        contractPrice: product.contract_price,
        pricingData: {
            pricing: {
                retailPrice: product.msrp,
                customerPrice: product.contract_price || product.unit_cost
            },
            availability: buildTDSynnexAvailability(product)
        },

        // Flags and derived fields
        productType: product.kit_standalone_flag || '',
        kitStandaloneFlag: product.kit_standalone_flag,
        type: skuType === 'Digital' ? 'TS::digital' : 'TS::physical',
        skuType: skuType,
        abcCode: product.abc_code,
        skuAttributes: product.sku_attributes,
        replacementSku: product.replacement_sku,

        // Derived boolean flags
        isLicensed: isTDSynnexLicensed(product.td_assigned_use, product.long_description),
        isServiceSku: isTDSynnexServiceSku(product.cat_description_1, product.cat_description_2),
        isNew: isTDSynnexNew(product.sku_created_date),
        isDigital: skuType === 'Digital',
        isDiscontinued: product.abc_code === 'C' || product.abc_code === 'T',

        // Physical dimensions (for reference)
        shipWeight: product.ship_weight,
        length: product.length,
        width: product.width,
        height: product.height,

        // Additional data
        upcCode: product.upc_code,
        commodityName: product.commodity_name,
        lastUpdated: product.last_updated,
        skuCreatedDate: product.sku_created_date,
        tdAssignedUse: product.td_assigned_use,

        // Promo info
        promoFlag: product.promo_flag,
        promoComment: product.promo_comment,
        promoExpiration: product.promo_expiration,
        etaDate: product.eta_date,

        // Source marker
        _source: 'tdsynnex',
        _rawProduct: product
    };
}

// Build availability data in Ingram-compatible format
function buildTDSynnexAvailability(product) {
    const qtyTotal = product.qty_total ?? 0;
    const isVirtual = qtyTotal === 9999;

    // Build warehouse breakdown
    const availabilityByWarehouse = [];
    for (const [field, info] of Object.entries(TDSYNNEX_WAREHOUSES)) {
        const qty = product[field];
        if (qty !== null && qty !== undefined && qty > 0) {
            availabilityByWarehouse.push({
                warehouseId: info.id,
                location: info.location,
                quantityAvailable: qty,
                quantityBackordered: 0
            });
        }
    }

    return {
        available: qtyTotal > 0,
        totalAvailability: isVirtual ? 'Unlimited' : qtyTotal,
        availabilityByWarehouse: availabilityByWarehouse,
        isVirtual: isVirtual
    };
}

// =====================================================
// MANUFACTURER SEARCH
// =====================================================
function debounceManufacturerSearch() {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(searchManufacturers, 300);
}

async function searchManufacturers() {
    const searchTerm = document.getElementById('manufacturerSearch').value.trim();
    const select = document.getElementById('manufacturerSelect');

    if (searchTerm.length < 2) {
        select.innerHTML = '<option value="">Type 2+ characters to search...</option>';
        document.getElementById('mfrCount').textContent = '';
        return;
    }

    showStatus(`Searching manufacturers matching "${searchTerm}"...`, 'loading');

    try {
        let manufacturers = [];

        if (state.currentDistributor === 'tdsynnex') {
            // TD Synnex: Use dedicated edge function
            manufacturers = await searchTDSynnexManufacturers(searchTerm);
        } else {
            // Ingram: Use proxy
            const response = await fetch(
                `${PROXY_BASE}?action=manufacturers&search=${encodeURIComponent(searchTerm)}`
            );
            const data = await response.json();
            manufacturers = data.manufacturers || [];
        }

        select.innerHTML = '<option value="">-- Select a manufacturer --</option>';

        if (manufacturers.length > 0) {
            manufacturers.forEach(mfr => {
                const option = document.createElement('option');
                option.value = mfr;
                option.textContent = mfr;
                select.appendChild(option);
            });
            document.getElementById('mfrCount').textContent = `(${manufacturers.length})`;
            showStatus(`Found ${manufacturers.length} manufacturers`, 'success');
        } else {
            select.innerHTML = '<option value="">No manufacturers found</option>';
            document.getElementById('mfrCount').textContent = '(0)';
            showStatus('No manufacturers found. Try a different search term.', 'info');
        }
    } catch (error) {
        showStatus('Error searching: ' + error.message, 'error');
    }
}

// =====================================================
// SKU-FIRST SEARCH FUNCTIONS
// =====================================================

/**
 * Handle the Load Products button click
 * Determines whether to use manufacturer-first or SKU-first flow
 */
function handleLoadProducts() {
    const skuValue = document.getElementById('skuSearch')?.value.trim() || '';

    if (state.manufacturer) {
        // Manufacturer is selected - use normal flow
        loadProducts(1);
    } else if (skuValue.length >= 2) {
        // No manufacturer but have SKU - use SKU-first flow
        lookupManufacturersFromSKU(skuValue);
    } else {
        // Neither manufacturer nor valid SKU
        showStatus('Please select a manufacturer or enter at least 2 characters for SKU search', 'error');
    }
}

/**
 * Look up manufacturers that have products matching the SKU pattern
 * @param {string} skuPattern - The SKU/part number pattern to search for
 */
async function lookupManufacturersFromSKU(skuPattern) {
    showStatus(`Searching for manufacturers with SKU matching "${skuPattern}"...`, 'loading');
    state.skuSearchMode = true;
    state.pendingSkuFilter = skuPattern;

    try {
        let manufacturers = [];

        if (state.currentDistributor === 'tdsynnex') {
            // TD SYNNEX: Call Supabase RPC get_manufacturers_by_sku
            const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_manufacturers_by_sku`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': SUPABASE_ANON_KEY,
                    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
                },
                body: JSON.stringify({
                    sku_pattern: skuPattern
                })
            });

            if (!response.ok) {
                throw new Error(`RPC call failed: ${response.status}`);
            }

            const data = await response.json();
            manufacturers = data || [];

        } else {
            // Ingram: Call productsWithPricing without vendor and extract unique vendors
            const url = `${PROXY_BASE}?action=productsWithPricing&keyword=${encodeURIComponent(skuPattern)}&page=1`;
            const response = await fetch(url);
            const data = await response.json();

            if (data.products && Array.isArray(data.products)) {
                // Extract unique vendor names with counts
                const vendorCounts = {};
                data.products.forEach(product => {
                    const vendorName = product.vendorName || 'Unknown';
                    vendorCounts[vendorName] = (vendorCounts[vendorName] || 0) + 1;
                });

                manufacturers = Object.entries(vendorCounts).map(([name, count]) => ({
                    manufacturer_name: name,
                    product_count: count
                }));
            }
        }

        if (manufacturers.length === 0) {
            showStatus(`No manufacturers found with products matching "${skuPattern}"`, 'info');
            state.skuSearchMode = false;
            state.pendingSkuFilter = '';
            return;
        }

        if (manufacturers.length === 1) {
            // Single manufacturer - auto-select it
            const mfr = manufacturers[0];
            const mfrName = mfr.manufacturer_name || mfr;
            await handleSingleManufacturerAutoSelect(mfrName, skuPattern);
        } else {
            // Multiple manufacturers - populate dropdown for user selection
            populateManufacturerDropdownFromSKU(manufacturers);
        }

    } catch (error) {
        console.error('[SKU Search] Error:', error);
        showStatus('Error searching by SKU: ' + error.message, 'error');
        state.skuSearchMode = false;
        state.pendingSkuFilter = '';
    }
}

/**
 * Handle auto-selection when SKU search returns a single manufacturer
 * @param {string} manufacturer - The manufacturer name
 * @param {string} skuValue - The SKU value to use as filter
 */
async function handleSingleManufacturerAutoSelect(manufacturer, skuValue) {
    // Set state
    state.manufacturer = manufacturer;
    state.skuKeyword = skuValue;

    // Update manufacturer dropdown to show selected value
    const select = document.getElementById('manufacturerSelect');
    select.innerHTML = `<option value="${manufacturer}" selected>${manufacturer}</option>`;

    // Update manufacturer badge
    const mfrBadge = document.getElementById('selectedMfrBadge');
    if (mfrBadge) {
        mfrBadge.textContent = manufacturer;
    }

    // Hide OR divider
    const orDivider = document.getElementById('orDivider');
    if (orDivider) {
        orDivider.classList.add('hidden');
    }

    // Show optional filters
    document.getElementById('optionalFiltersRow').style.display = 'flex';

    // Keep the SKU value in the top search field and update placeholder
    const skuSearchField = document.getElementById('skuSearch');
    const skuSearchRow = document.getElementById('skuSearchRow');
    if (skuSearchField) {
        skuSearchField.value = skuValue;
        skuSearchField.placeholder = `Filter ${manufacturer} products by SKU...`;
    }
    if (skuSearchRow) {
        skuSearchRow.classList.add('filter-mode');
    }

    showStatus(`Auto-selected ${manufacturer}. Loading categories...`, 'loading');

    // Load categories from the manufacturer
    await loadFilterOptions('category');

    // Load products with the SKU filter
    await loadProducts(1);

    // Clear SKU search mode flags
    state.skuSearchMode = false;
    state.pendingSkuFilter = '';
}

/**
 * Populate the manufacturer dropdown with results from SKU search
 * @param {Array} manufacturers - Array of {manufacturer_name, product_count} objects
 */
function populateManufacturerDropdownFromSKU(manufacturers) {
    const select = document.getElementById('manufacturerSelect');

    // Clear and populate with SKU-matched manufacturers
    select.innerHTML = '<option value="">-- Select a manufacturer --</option>';

    manufacturers.forEach(mfr => {
        const name = mfr.manufacturer_name || mfr;
        const count = mfr.product_count || 0;
        const option = document.createElement('option');
        option.value = name;
        option.textContent = count > 0 ? `${name} (${count} matches)` : name;
        select.appendChild(option);
    });

    // Store options for reference
    state.skuManufacturerOptions = manufacturers;

    // Update count badge
    document.getElementById('mfrCount').textContent = `(${manufacturers.length})`;

    // Hide OR divider
    const orDivider = document.getElementById('orDivider');
    if (orDivider) {
        orDivider.classList.add('hidden');
    }

    showStatus(`Found ${manufacturers.length} manufacturers with matching SKUs. Please select one.`, 'info');
}

// =====================================================
// MANUFACTURER SELECTION
// =====================================================
async function onManufacturerSelect() {
    const select = document.getElementById('manufacturerSelect');
    state.manufacturer = select.value;

    // Hide OR divider when manufacturer is selected
    const orDivider = document.getElementById('orDivider');

    if (!state.manufacturer) {
        // Manufacturer cleared - reset state
        resetOptionalFilters();
        resetProducts();
        document.getElementById('optionalFiltersRow').style.display = 'none';
        document.getElementById('selectedMfrBadge').textContent = '';

        // Show OR divider when manufacturer is cleared
        if (orDivider) {
            orDivider.classList.remove('hidden');
        }

        // Reset SKU search mode and restore default placeholder
        state.skuSearchMode = false;
        state.pendingSkuFilter = '';
        state.skuManufacturerOptions = [];

        const skuSearchField = document.getElementById('skuSearch');
        const skuSearchRow = document.getElementById('skuSearchRow');
        if (skuSearchField) {
            skuSearchField.placeholder = 'Enter partial or full SKU (e.g. AB123, XYZ-456)...';
        }
        if (skuSearchRow) {
            skuSearchRow.classList.remove('filter-mode');
        }

        return;
    }

    // Hide OR divider when manufacturer is selected
    if (orDivider) {
        orDivider.classList.add('hidden');
    }

    // Check if we're in SKU search mode with a pending filter
    const hasPendingSkuFilter = state.skuSearchMode && state.pendingSkuFilter;

    if (!hasPendingSkuFilter) {
        // Normal manufacturer-first flow
        resetOptionalFilters();
        resetProducts();
    }

    document.getElementById('optionalFiltersRow').style.display = 'flex';

    // Update manufacturer badge
    const mfrBadge = document.getElementById('selectedMfrBadge');
    if (mfrBadge) {
        mfrBadge.textContent = state.manufacturer;
    }

    // Update SKU field placeholder to indicate filter mode
    const skuSearchField = document.getElementById('skuSearch');
    const skuSearchRow = document.getElementById('skuSearchRow');
    if (skuSearchField) {
        skuSearchField.placeholder = `Filter ${state.manufacturer} products by SKU...`;
    }
    if (skuSearchRow) {
        skuSearchRow.classList.add('filter-mode');
    }

    showStatus(`Manufacturer: ${state.manufacturer}. Loading categories...`, 'loading');

    await loadFilterOptions('category');

    // If we have a pending SKU filter from SKU-first search, apply it
    if (hasPendingSkuFilter) {
        state.skuKeyword = state.pendingSkuFilter;

        // Keep the SKU value in the top search field
        if (skuSearchField) {
            skuSearchField.value = state.pendingSkuFilter;
        }

        // Load products with the SKU filter
        await loadProducts(1);

        // Clear SKU search mode flags
        state.skuSearchMode = false;
        state.pendingSkuFilter = '';
    } else {
        showStatus(`Manufacturer: ${state.manufacturer}. Use filters or click Load Products.`, 'success');
    }
}

// =====================================================
// FILTER LOADING
// =====================================================
async function loadFilterOptions(filterType) {
    const currentParams = `${state.manufacturer}|${state.category}|${state.subcategory}|${state.cat3}|${state.skuType}`;

    if (state.loadingFilters[filterType]) return;
    if (state.filterParams[filterType] === currentParams) return;

    state.loadingFilters[filterType] = true;

    let selectEl, countEl;

    // Map filter type to DOM elements
    switch (filterType) {
        case 'category':
            selectEl = document.getElementById('categorySelect');
            countEl = document.getElementById('catCount');
            break;
        case 'subcategory':
            selectEl = document.getElementById('subcategorySelect');
            countEl = document.getElementById('subCatCount');
            break;
        case 'cat3':
            selectEl = document.getElementById('cat3Select');
            countEl = document.getElementById('cat3Count');
            break;
        default:
            state.loadingFilters[filterType] = false;
            return;
    }

    const currentValue = selectEl.value;
    selectEl.innerHTML = '<option value="">Loading...</option>';

    try {
        let items = [];

        if (state.currentDistributor === 'tdsynnex') {
            // TD Synnex: Use dedicated edge function
            let categories = [];
            if (filterType === 'category') {
                categories = await loadTDSynnexCategories(state.manufacturer);
            } else if (filterType === 'subcategory' && state.category) {
                categories = await loadTDSynnexCategories(state.manufacturer, state.category);
            } else if (filterType === 'cat3' && state.category && state.subcategory) {
                categories = await loadTDSynnexCategories(state.manufacturer, state.category, state.subcategory);
            }
            items = categories.map(c => c.name);
        } else {
            // Ingram: Use proxy
            let url = `${PROXY_BASE}?vendor=${encodeURIComponent(state.manufacturer)}`;
            let dataKey;

            switch (filterType) {
                case 'category':
                    url += `&action=categories`;
                    if (state.subcategory) url += `&subCategory=${encodeURIComponent(state.subcategory)}`;
                    if (state.skuType) url += `&type=${encodeURIComponent(state.skuType)}`;
                    dataKey = 'categories';
                    break;
                case 'subcategory':
                    url += `&action=subcategories`;
                    if (state.category) url += `&category=${encodeURIComponent(state.category)}`;
                    if (state.skuType) url += `&type=${encodeURIComponent(state.skuType)}`;
                    dataKey = 'subcategories';
                    break;
                default:
                    // Ingram doesn't have cat3
                    state.loadingFilters[filterType] = false;
                    return;
            }

            const response = await fetch(url);
            const data = await response.json();
            console.log(`[Ingram ${filterType}] URL:`, url);
            console.log(`[Ingram ${filterType}] Response:`, data);
            items = data[dataKey] || [];
        }

        selectEl.innerHTML = '<option value="">-- Any --</option>';

        if (items.length > 0) {
            items.forEach(item => {
                const option = document.createElement('option');
                option.value = item;
                option.textContent = item;
                selectEl.appendChild(option);
            });
            countEl.textContent = `(${items.length})`;

            if (currentValue && items.includes(currentValue)) {
                selectEl.value = currentValue;
            }
        } else {
            countEl.textContent = '(0)';
        }

        state.filterParams[filterType] = currentParams;

    } catch (error) {
        console.error(`Error loading ${filterType}:`, error);
        selectEl.innerHTML = '<option value="">-- Error --</option>';
    }

    state.loadingFilters[filterType] = false;
}

function formatSKUType(type) {
    switch (type) {
        case 'IM::physical':
        case 'IM::Physical':
        case 'Physical':
            return 'Physical';
        case 'IM::digital':
        case 'IM::Digital':
        case 'Digital':
            return 'Digital';
        case 'IM::subscription':
        case 'IM::Subscription':
        case 'Subscription':
            return 'Subscription';
        default:
            return type || '-';
    }
}

function formatProductClass(code) {
    const definitions = {
        'A': 'Stocked in all warehouses',
        'B': 'Stocked in limited warehouses',
        'C': 'Stocked in fewer warehouses',
        'D': 'Discontinued by Ingram',
        'E': 'Vendor phase-out',
        'F': 'Contract-specific product',
        'N': 'New SKU (pre-receipt)',
        'O': 'Discontinued - liquidation',
        'S': 'Special order / backorder',
        'X': 'Direct ship from vendor',
        'V': 'Discontinued by vendor'
    };

    if (!code) return '-';
    const upperCode = code.toUpperCase();
    const definition = definitions[upperCode];
    return definition ? `${upperCode} - ${definition}` : code;
}

async function onFilterChange(filterType) {
    const selectEl = document.getElementById(
        filterType === 'category' ? 'categorySelect' :
        filterType === 'subcategory' ? 'subcategorySelect' :
        filterType === 'cat3' ? 'cat3Select' :
        'skuTypeSelect'
    );

    state[filterType] = selectEl.value;

    // Reset dependent filters
    if (filterType !== 'category') state.filterParams.category = '';
    if (filterType !== 'subcategory') state.filterParams.subcategory = '';
    if (filterType !== 'cat3') state.filterParams.cat3 = '';

    // Clear downstream filters when parent changes
    if (filterType === 'category') {
        state.subcategory = '';
        state.cat3 = '';
        document.getElementById('subcategorySelect').innerHTML = '<option value="">-- Any --</option>';
        document.getElementById('subCatCount').textContent = '';
        if (state.currentDistributor === 'tdsynnex') {
            document.getElementById('cat3Select').innerHTML = '<option value="">-- Any --</option>';
            document.getElementById('cat3Count').textContent = '';
        }
    } else if (filterType === 'subcategory' && state.currentDistributor === 'tdsynnex') {
        state.cat3 = '';
        document.getElementById('cat3Select').innerHTML = '<option value="">-- Any --</option>';
        document.getElementById('cat3Count').textContent = '';
    }

    resetProducts();

    // Load child categories
    if (filterType === 'category' && state.category) {
        await loadFilterOptions('subcategory');
    } else if (filterType === 'subcategory' && state.subcategory && state.currentDistributor === 'tdsynnex') {
        await loadFilterOptions('cat3');
    }
}

// =====================================================
// PRODUCTS LOADING
// =====================================================
async function loadProducts(page = 1) {
    if (!state.manufacturer) {
        showStatus('Please select a manufacturer first', 'error');
        return;
    }

    state.currentPage = page;
    const productsSection = document.getElementById('productsSection');
    productsSection.style.display = 'block';
    showStatus('Loading products with pricing...', 'loading');

    try {
        let products = [];
        let pagination = null;

        if (state.currentDistributor === 'tdsynnex') {
            // TD Synnex: Use dedicated edge function
            const offset = (page - 1) * PAGE_SIZE;
            const result = await searchTDSynnexProducts(state.manufacturer, {
                search: state.skuKeyword || '',
                cat1: state.category || '',
                cat2: state.subcategory || '',
                cat3: state.cat3 || '',
                limit: PAGE_SIZE,
                offset: offset
            });
            products = result.products;
            pagination = result.pagination;
        } else {
            // Ingram: Use proxy
            let url = `${PROXY_BASE}?action=productsWithPricing&vendor=${encodeURIComponent(state.manufacturer)}&page=${page}`;
            if (state.category) url += `&category=${encodeURIComponent(state.category)}`;
            if (state.subcategory) url += `&subCategory=${encodeURIComponent(state.subcategory)}`;
            if (state.skuType) url += `&type=${encodeURIComponent(state.skuType)}`;
            if (state.skuKeyword && state.skuKeyword.length >= 2) {
                url += `&keyword=${encodeURIComponent(state.skuKeyword)}`;
            }

            const response = await fetch(url);
            const data = await response.json();
            // Add _source marker to Ingram products for consistency with TD Synnex
            products = (data.products || []).map(p => ({ ...p, _source: 'ingram' }));
            pagination = data.pagination;
        }

        if (products.length > 0) {
            // Store total records for pagination display
            state.totalRecords = pagination?.totalRecords || products.length;
            state.totalPages = pagination?.totalPages || 1;

            displayProductsWithPricing(products, pagination);
            showStatus('', '');
        } else {
            document.getElementById('productsBody').innerHTML =
                '<tr><td colspan="5" class="no-results">No products found</td></tr>';
            document.getElementById('pagination').innerHTML = '';
            document.getElementById('productCount').textContent = '0 products';
            showStatus('No products found with current filters', 'info');
        }
    } catch (error) {
        showStatus('Error loading products: ' + error.message, 'error');
    }
}

function displayProductsWithPricing(products, pagination) {
    const tbody = document.getElementById('productsBody');
    tbody.innerHTML = '';

    const sortedProducts = [...products].sort((a, b) => {
        const partA = (a.vendorPartNumber || '').toLowerCase();
        const partB = (b.vendorPartNumber || '').toLowerCase();
        return partA.localeCompare(partB, undefined, { numeric: true, sensitivity: 'base' });
    });

    state.currentProducts = sortedProducts;
    state.pricingData = {};

    sortedProducts.forEach((product, index) => {
        const partNumber = product.ingramPartNumber || product.vendorPartNumber;
        const isSelected = state.selectedProducts.has(partNumber);
        const isQueued = state.queuedProducts.some(p =>
            (p.ingramPartNumber || p.vendorPartNumber) === partNumber
        );

        const pricingData = product.pricingData;
        const msrp = pricingData?.pricing?.retailPrice;
        const msrpDisplay = msrp
            ? `<span class="price-available">$${msrp.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`
            : '<span class="price-unavailable">-</span>';

        if (pricingData && product.ingramPartNumber) {
            state.pricingData[product.ingramPartNumber] = pricingData;
        }

        const tr = document.createElement('tr');
        tr.className = isSelected ? 'selected' : '';
        if (isQueued) tr.classList.add('queued');
        tr.id = `product-row-${index}`;

        const fullDescription = product.description || '-';
        // Simplified table: Checkbox, Part Number, Description (with hover tooltip), MSRP, Info
        tr.innerHTML = `
            <td class="col-checkbox">
                <input type="checkbox"
                       onchange="toggleProduct('${partNumber}', this.checked)"
                       ${isSelected ? 'checked' : ''}
                       ${isQueued ? 'disabled title="Already in queue"' : ''}>
            </td>
            <td class="col-part"><strong>${product.vendorPartNumber || '-'}</strong></td>
            <td class="col-desc desc-cell" title="${fullDescription.replace(/"/g, '&quot;')}">${fullDescription}</td>
            <td class="col-price">${msrpDisplay}</td>
            <td class="col-action">
                <button class="info-btn" onclick="showProductDetails(${index})" title="View details">i</button>
            </td>
        `;
        tbody.appendChild(tr);

        tr.dataset.product = JSON.stringify(product);
    });

    // Use stored total records for accurate count across all pages
    document.getElementById('productCount').textContent =
        `${state.totalRecords.toLocaleString()} products`;

    renderPagination(pagination);
    updateSelectedCount();
}

function renderPagination(pagination) {
    const paginationDiv = document.getElementById('pagination');

    if (!pagination || pagination.totalPages <= 1) {
        paginationDiv.innerHTML = '';
        return;
    }

    paginationDiv.innerHTML = `
        <button onclick="loadProducts(${pagination.page - 1})"
                ${pagination.page === 1 ? 'disabled' : ''} class="btn-secondary btn-small">
            Prev
        </button>
        <span>Page ${pagination.page} of ${pagination.totalPages} (${state.totalRecords.toLocaleString()} total)</span>
        <button onclick="loadProducts(${pagination.page + 1})"
                ${pagination.page >= pagination.totalPages ? 'disabled' : ''} class="btn-secondary btn-small">
            Next
        </button>
    `;
}

// =====================================================
// PRODUCT SELECTION
// =====================================================
function toggleProduct(partNumber, isChecked) {
    const rows = document.querySelectorAll('#productsBody tr');

    rows.forEach(row => {
        const productData = row.dataset.product;
        if (productData) {
            const product = JSON.parse(productData);
            const pn = product.ingramPartNumber || product.vendorPartNumber;

            if (pn === partNumber) {
                if (isChecked) {
                    state.selectedProducts.set(partNumber, product);
                    row.classList.add('selected');
                } else {
                    state.selectedProducts.delete(partNumber);
                    row.classList.remove('selected');
                }
            }
        }
    });

    updateSelectedCount();
}

function toggleSelectAll() {
    const selectAllChecked = document.getElementById('selectAll').checked;
    const checkboxes = document.querySelectorAll('#productsBody input[type="checkbox"]:not(:disabled)');

    checkboxes.forEach(cb => {
        cb.checked = selectAllChecked;
        const row = cb.closest('tr');
        const productData = row.dataset.product;

        if (productData) {
            const product = JSON.parse(productData);
            const partNumber = product.ingramPartNumber || product.vendorPartNumber;

            if (selectAllChecked) {
                state.selectedProducts.set(partNumber, product);
                row.classList.add('selected');
            } else {
                state.selectedProducts.delete(partNumber);
                row.classList.remove('selected');
            }
        }
    });

    updateSelectedCount();
}

function updateSelectedCount() {
    const count = state.selectedProducts.size;
    document.getElementById('selectedCount').textContent = count;

    const addToQueueBtn = document.getElementById('addToQueueBtn');
    if (addToQueueBtn) {
        addToQueueBtn.disabled = count === 0;
    }
}

// =====================================================
// QUEUE MANAGEMENT
// =====================================================
function addSelectedToQueue() {
    const selectedArray = Array.from(state.selectedProducts.values());

    if (selectedArray.length === 0) {
        showStatus('No products selected', 'error');
        return;
    }

    let addedCount = 0;
    selectedArray.forEach(product => {
        const partNumber = product.ingramPartNumber || product.vendorPartNumber;
        const alreadyQueued = state.queuedProducts.some(p =>
            (p.ingramPartNumber || p.vendorPartNumber) === partNumber
        );

        if (!alreadyQueued) {
            // Enrich product with pricing data if available
            const pricingData = product.pricingData || state.pricingData?.[product.ingramPartNumber];
            const enrichedProduct = { ...product, pricingData };
            state.queuedProducts.push(enrichedProduct);
            addedCount++;
        }
    });

    // Clear current selection
    state.selectedProducts.clear();
    updateSelectedCount();

    // Uncheck all checkboxes
    document.querySelectorAll('#productsBody input[type="checkbox"]').forEach(cb => {
        cb.checked = false;
        cb.closest('tr').classList.remove('selected');
    });
    document.getElementById('selectAll').checked = false;

    // Refresh product display to show queued items as disabled
    if (state.currentProducts.length > 0) {
        displayProductsWithPricing(state.currentProducts, {
            totalRecords: state.totalRecords,
            page: state.currentPage,
            totalPages: state.totalPages
        });
    }

    updateQueueUI();

    if (addedCount > 0) {
        showStatus(`Added ${addedCount} product(s) to queue`, 'success');
    } else {
        showStatus('Products already in queue', 'info');
    }
}

function removeFromQueue(partNumber) {
    state.queuedProducts = state.queuedProducts.filter(p =>
        (p.ingramPartNumber || p.vendorPartNumber) !== partNumber
    );
    updateQueueUI();

    // Re-enable checkbox in products table if visible
    document.querySelectorAll('#productsBody input[type="checkbox"][disabled]').forEach(cb => {
        const row = cb.closest('tr');
        const productData = row.dataset.product;
        if (productData) {
            const product = JSON.parse(productData);
            const pn = product.ingramPartNumber || product.vendorPartNumber;
            if (pn === partNumber) {
                cb.disabled = false;
                cb.title = '';
                row.classList.remove('queued');
            }
        }
    });
}

function clearQueue() {
    state.queuedProducts = [];
    updateQueueUI();

    // Re-enable all disabled checkboxes
    document.querySelectorAll('#productsBody input[type="checkbox"][disabled]').forEach(cb => {
        cb.disabled = false;
        cb.title = '';
        cb.closest('tr').classList.remove('queued');
    });

    showStatus('Queue cleared', 'info');
}

function updateQueueUI() {
    const queueCount = state.queuedProducts.length;

    document.getElementById('queueCount').textContent = queueCount;

    const queueEmpty = document.getElementById('queueEmpty');
    const queueList = document.getElementById('queueList');
    const queueFooter = document.getElementById('queueFooter');
    const clearQueueBtn = document.getElementById('clearQueueBtn');
    const queueOptions = document.getElementById('queueOptions');

    if (queueCount === 0) {
        queueEmpty.style.display = 'flex';
        queueList.style.display = 'none';
        queueFooter.style.display = 'none';
        clearQueueBtn.style.display = 'none';
        if (queueOptions) queueOptions.style.display = 'none';
    } else {
        queueEmpty.style.display = 'none';
        queueList.style.display = 'block';
        queueFooter.style.display = 'block';
        clearQueueBtn.style.display = 'block';
        if (queueOptions) queueOptions.style.display = 'block';

        renderQueueItems();
    }
}

function renderQueueItems() {
    const queueItems = document.getElementById('queueItems');
    queueItems.innerHTML = '';

    if (state.groupByManufacturer) {
        // Group products by manufacturer
        const groups = {};
        state.queuedProducts.forEach(product => {
            const mfr = product.vendorName || state.manufacturer || 'Unknown';
            if (!groups[mfr]) {
                groups[mfr] = [];
            }
            groups[mfr].push(product);
        });

        // Render grouped
        Object.keys(groups).sort().forEach(mfr => {
            // Add manufacturer header (draggable)
            const header = document.createElement('div');
            header.className = 'queue-mfr-group';
            header.textContent = mfr;
            header.draggable = true;
            header.dataset.manufacturer = mfr;
            queueItems.appendChild(header);

            // Add items for this manufacturer
            groups[mfr].forEach((product, index) => {
                queueItems.appendChild(createQueueItemElement(product, index));
            });
        });
    } else {
        // Render flat list
        state.queuedProducts.forEach((product, index) => {
            queueItems.appendChild(createQueueItemElement(product, index));
        });
    }
}

function createQueueItemElement(product, index) {
    const partNumber = product.ingramPartNumber || product.vendorPartNumber;
    const msrp = product.pricingData?.pricing?.retailPrice || product.retailPrice;
    const msrpDisplay = msrp
        ? `$${msrp.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : '-';

    const li = document.createElement('li');
    li.className = 'queue-item';
    li.draggable = true;
    li.dataset.partNumber = partNumber;
    li.dataset.index = index;

    // Minimal: drag handle, part number, price, remove button
    li.innerHTML = `
        <div class="queue-item-drag">
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/>
                <circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/>
            </svg>
        </div>
        <div class="queue-item-info">
            <div class="queue-item-part">${product.vendorPartNumber || '-'}</div>
        </div>
        <div class="queue-item-price">${msrpDisplay}</div>
        <button class="queue-item-remove" onclick="removeFromQueue('${partNumber}')" title="Remove">
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 6 6 18M6 6l12 12"/>
            </svg>
        </button>
    `;

    return li;
}

// =====================================================
// MANUFACTURER NORMALIZATION
// =====================================================
async function normalizeManufacturer(name, distributor) {
    if (!name) return name;
    try {
        console.log(`[MfrNorm] Calling RPC for: "${name}" (${distributor})`);
        const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/normalize_manufacturer_name`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            },
            body: JSON.stringify({
                input_name: name,
                source_distributor: distributor
            })
        });
        console.log(`[MfrNorm] Response status: ${response.status}`);
        const result = await response.json();
        console.log(`[MfrNorm] Result: ${JSON.stringify(result)}`);
        if (response.ok && result) {
            console.log(`[MfrNorm] SUCCESS: "${name}" -> "${result}"`);
            return result;
        }
        console.log(`[MfrNorm] No result, returning original: "${name}"`);
        return name;
    } catch (error) {
        console.error('[MfrNorm] ERROR:', error);
        return name;
    }
}

// =====================================================
// MANUFACTURER RESOLUTION - BATCH RPC FUNCTIONS
// =====================================================

/**
 * Check manufacturer mappings in batch via Supabase RPC
 * @param {Array} manufacturers - Array of {name: string, distributor: string}
 * @returns {Promise<Array>} - Array of {name, distributor, found, canonical_name}
 */
async function checkManufacturerMappingsBatch(manufacturers) {
    if (!manufacturers || manufacturers.length === 0) return [];

    try {
        console.log('[MfrResolution] Checking mappings for:', manufacturers);
        const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/check_manufacturer_mappings_batch`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            },
            body: JSON.stringify({
                p_mappings: manufacturers
            })
        });

        if (!response.ok) {
            throw new Error(`RPC call failed: ${response.status}`);
        }

        const results = await response.json();
        console.log('[MfrResolution] Mapping check results:', results);
        return results || [];
    } catch (error) {
        console.error('[MfrResolution] Error checking mappings:', error);
        throw error;
    }
}

/**
 * Save manufacturer mappings in batch via Supabase RPC
 * @param {Array} mappings - Array of {distributor_name, canonical_name, source}
 * @returns {Promise<Object>} - {success: boolean, saved_count: number}
 */
async function saveManufacturerMappingsBatch(mappings) {
    if (!mappings || mappings.length === 0) return { success: true, saved_count: 0 };

    try {
        console.log('[MfrResolution] Saving mappings:', mappings);
        const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/save_manufacturer_mappings_batch`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            },
            body: JSON.stringify({
                p_mappings: mappings
            })
        });

        if (!response.ok) {
            throw new Error(`RPC call failed: ${response.status}`);
        }

        const result = await response.json();
        console.log('[MfrResolution] Save result:', result);
        return result || { success: false, saved_count: 0 };
    } catch (error) {
        console.error('[MfrResolution] Error saving mappings:', error);
        throw error;
    }
}

// =====================================================
// MANUFACTURER RESOLUTION - PANEL FUNCTIONS
// =====================================================

/**
 * Show the manufacturer resolution panel with unresolved manufacturers
 * @param {Array} unresolvedList - Array of {distributorName, distributor}
 * @returns {Promise} - Resolves with normalized map or rejects on cancel
 */
async function showMfrResolutionPanel(unresolvedList) {
    // If no prefetched manufacturers, try to fetch from Zoho directly
    if (state.prefetchedManufacturers.length === 0 && typeof ZOHO !== 'undefined') {
        console.log('[MfrResolution] No prefetched manufacturers, attempting direct Zoho fetch...');
        try {
            const response = await ZOHO.CRM.API.getAllRecords({
                Entity: "Manufacturers",
                sort_by: "Name",
                sort_order: "asc",
                per_page: 200
            });

            if (response && response.data && Array.isArray(response.data)) {
                state.prefetchedManufacturers = response.data
                    .map(record => record.Name || '')
                    .filter(name => name.length > 0)
                    .sort();
                console.log(`[MfrResolution] Fetched ${state.prefetchedManufacturers.length} manufacturers directly from Zoho`);
            }
        } catch (error) {
            console.warn('[MfrResolution] Failed to fetch manufacturers from Zoho:', error);
        }
    }

    return new Promise((resolve, reject) => {
        state.unresolvedManufacturers = unresolvedList;
        state.mfrResolutions = new Map();
        state.mfrResolutionPromise = { resolve, reject };

        renderMfrResolutionTable();
        updateMfrResolutionStatus();

        // Initialize tooltip positioning after table is rendered
        initMfrResolutionTooltips();

        const panel = document.getElementById('mfrResolutionPanel');
        if (panel) {
            panel.style.display = 'block';
            panel.classList.remove('collapsed');
            panel.classList.remove('all-resolved');
            panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        const collapseBtn = document.getElementById('mfrCollapseBtn');
        if (collapseBtn) {
            collapseBtn.classList.remove('collapsed');
        }
    });
}

/**
 * Hide the manufacturer resolution panel
 */
function hideMfrResolutionPanel() {
    const panel = document.getElementById('mfrResolutionPanel');
    if (panel) {
        panel.style.display = 'none';
    }
    state.unresolvedManufacturers = [];
    state.mfrResolutions = new Map();
    state.mfrResolutionPromise = null;
}

/**
 * Toggle panel collapse state
 */
function toggleMfrPanelCollapse() {
    const panel = document.getElementById('mfrResolutionPanel');
    const collapseBtn = document.getElementById('mfrCollapseBtn');

    if (panel && collapseBtn) {
        panel.classList.toggle('collapsed');
        collapseBtn.classList.toggle('collapsed');
    }
}

/**
 * Render the resolution table rows with distributor group separators
 */
function renderMfrResolutionTable() {
    const tbody = document.getElementById('mfrResolutionTableBody');
    if (!tbody) return;

    // Debug: Log prefetchedManufacturers
    console.log('[MfrResolution] Rendering table with', state.prefetchedManufacturers.length, 'Zoho manufacturers');

    const zohoOptions = state.prefetchedManufacturers
        .map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`)
        .join('');

    // Group manufacturers by distributor for group separators
    let html = '';
    let currentDistributor = '';

    state.unresolvedManufacturers.forEach((mfr, index) => {
        // Debug: Log manufacturer data to verify correct fields
        console.log(`[MfrResolution] Row ${index}: name="${mfr.distributorName}", distributor="${mfr.distributor}"`);

        // Determine distributor label and class based on source
        // mfr.distributor should be 'ingram' or 'tdsynnex'
        const distributorLabel = mfr.distributor === 'ingram' ? 'INGRAM MICRO' :
                                  mfr.distributor === 'tdsynnex' ? 'TD SYNNEX' :
                                  'UNKNOWN';
        const distributorClass = mfr.distributor === 'ingram' ? 'ingram' :
                                  mfr.distributor === 'tdsynnex' ? 'tdsynnex' :
                                  'unknown';

        // Add distributor group separator when distributor changes
        if (mfr.distributor !== currentDistributor) {
            currentDistributor = mfr.distributor;
            const count = state.unresolvedManufacturers.filter(m => m.distributor === currentDistributor).length;
            html += `
                <tr class="mfr-group-separator">
                    <td colspan="4">
                        <div class="mfr-group-label">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
                            </svg>
                            ${distributorLabel}
                            <span class="mfr-group-count">${count}</span>
                        </div>
                    </td>
                </tr>
            `;
        }

        // Add manufacturer row
        html += `
            <tr id="mfr-row-${index}" class="mfr-row">
                <td class="col-source">
                    <div class="mfr-distributor-cell">
                        <span class="mfr-name-cell">${escapeHtml(mfr.distributorName)}</span>
                    </div>
                </td>
                <td>
                    <div class="mfr-select-wrapper">
                        <select
                            class="mfr-select"
                            id="mfr-select-${index}"
                            data-index="${index}"
                            onchange="handleMfrSelectChange(${index})"
                        >
                            <option value="">-- Select manufacturer --</option>
                            ${zohoOptions}
                        </select>
                        <span class="mfr-select-arrow">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M6 9l6 6 6-6"/>
                            </svg>
                        </span>
                    </div>
                </td>
                <td class="td-or"></td>
                <td>
                    <div class="mfr-input-wrapper">
                        <input
                            type="text"
                            class="mfr-input"
                            id="mfr-input-${index}"
                            data-index="${index}"
                            placeholder="Enter new name..."
                            oninput="handleMfrInputChange(${index})"
                        />
                        <span id="mfr-status-${index}" class="mfr-row-status">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M5 12l5 5L20 7"/>
                            </svg>
                        </span>
                    </div>
                </td>
            </tr>
        `;
    });

    tbody.innerHTML = html;
}

/**
 * Handle select dropdown change
 */
function handleMfrSelectChange(index) {
    const select = document.getElementById(`mfr-select-${index}`);
    const input = document.getElementById(`mfr-input-${index}`);
    const row = document.getElementById(`mfr-row-${index}`);
    const status = document.getElementById(`mfr-status-${index}`);

    if (select.value) {
        // Disable input, set resolution
        input.value = '';
        input.disabled = true;
        state.mfrResolutions.set(index, { type: 'zoho', value: select.value });
        row.classList.add('row-valid');
        status.classList.add('show', 'valid');
    } else {
        // Re-enable input
        input.disabled = false;
        state.mfrResolutions.delete(index);
        row.classList.remove('row-valid');
        status.classList.remove('show', 'valid');
    }

    updateMfrResolutionStatus();
}

/**
 * Handle text input change
 */
function handleMfrInputChange(index) {
    const select = document.getElementById(`mfr-select-${index}`);
    const input = document.getElementById(`mfr-input-${index}`);
    const row = document.getElementById(`mfr-row-${index}`);
    const status = document.getElementById(`mfr-status-${index}`);

    // Auto-convert to Title Case while preserving cursor position
    const cursorPos = input.selectionStart;
    const originalLength = input.value.length;
    input.value = toTitleCase(input.value);
    const newLength = input.value.length;
    // Restore cursor position (adjust if length changed, though it shouldn't for title case)
    input.setSelectionRange(cursorPos + (newLength - originalLength), cursorPos + (newLength - originalLength));

    if (input.value.trim()) {
        // Disable select, set resolution
        select.value = '';
        select.disabled = true;
        state.mfrResolutions.set(index, { type: 'new', value: input.value.trim() });
        row.classList.add('row-valid');
        status.classList.add('show', 'valid');
    } else {
        // Re-enable select
        select.disabled = false;
        state.mfrResolutions.delete(index);
        row.classList.remove('row-valid');
        status.classList.remove('show', 'valid');
    }

    updateMfrResolutionStatus();
}

/**
 * Update the resolution status display
 */
function updateMfrResolutionStatus() {
    const total = state.unresolvedManufacturers.length;
    const resolved = state.mfrResolutions.size;
    const allResolved = resolved === total && total > 0;

    // Update count badge
    const countEl = document.getElementById('mfrUnresolvedCount');
    if (countEl) {
        countEl.textContent = total - resolved || total;
    }

    // Update status text
    const statusText = document.getElementById('mfrStatusText');
    if (statusText) {
        statusText.textContent = `${resolved} of ${total} resolved`;
    }

    // Update status dot
    const statusDot = document.getElementById('mfrStatusDot');
    if (statusDot) {
        statusDot.classList.toggle('complete', allResolved);
        statusDot.classList.toggle('incomplete', !allResolved);
    }

    // Update confirm button
    const confirmBtn = document.getElementById('mfrConfirmBtn');
    if (confirmBtn) {
        confirmBtn.disabled = !allResolved;
    }

    // Update panel border color when all resolved
    const panel = document.getElementById('mfrResolutionPanel');
    if (panel) {
        panel.classList.toggle('all-resolved', allResolved);
    }
}

/**
 * Cancel resolution - reject the promise and hide panel
 */
function cancelMfrResolution() {
    if (state.mfrResolutionPromise) {
        state.mfrResolutionPromise.reject(new Error('Resolution cancelled by user'));
    }
    hideMfrResolutionPanel();
    showStatus('Submission cancelled. Queue remains intact.', 'info');
}

/**
 * Confirm all resolutions - save to Supabase and resolve promise
 */
async function confirmMfrResolutions() {
    if (state.mfrResolutions.size !== state.unresolvedManufacturers.length) {
        showStatus('Please resolve all manufacturers before confirming', 'error');
        return;
    }

    // Disable button to prevent double-clicks
    const confirmBtn = document.getElementById('mfrConfirmBtn');
    if (confirmBtn) confirmBtn.disabled = true;

    showStatus('Saving manufacturer mappings...', 'loading');

    try {
        // Build the mapping list for batch save
        const mappingsToSave = [];
        const normalizedMap = new Map();

        for (const [index, resolution] of state.mfrResolutions) {
            const mfr = state.unresolvedManufacturers[index];
            const canonicalName = resolution.value;
            const source = mfr.distributor;

            // Add to mappings to save
            mappingsToSave.push({
                distributor_name: mfr.distributorName,
                canonical_name: canonicalName,
                distributor: source
            });

            // Add to normalized map for immediate use
            normalizedMap.set(mfr.distributorName, canonicalName);
        }

        // Save to Supabase
        const saveResult = await saveManufacturerMappingsBatch(mappingsToSave);

        if (saveResult.success || saveResult.saved_count >= 0) {
            console.log(`[MfrResolution] Saved ${saveResult.saved_count} mappings`);

            // Hide panel and resolve promise with the normalized map
            hideMfrResolutionPanel();

            if (state.mfrResolutionPromise) {
                state.mfrResolutionPromise.resolve(normalizedMap);
            }

            showStatus(`Saved ${saveResult.saved_count} manufacturer mapping(s). Continuing submission...`, 'success');
        } else {
            throw new Error('Failed to save mappings');
        }
    } catch (error) {
        console.error('[MfrResolution] Error confirming resolutions:', error);
        showStatus('Error saving mappings: ' + error.message, 'error');
        // Re-enable button on error
        if (confirmBtn) confirmBtn.disabled = false;
    }
}

/**
 * Escape HTML for safe rendering
 */
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Convert string to Title Case (first letter of each word capitalized, rest lowercase)
 */
function toTitleCase(str) {
    if (!str) return '';
    return str.toLowerCase().replace(/(?:^|\s)\S/g, char => char.toUpperCase());
}

// =====================================================
// MANUFACTURER MAPPINGS REFERENCE PANEL
// =====================================================

/**
 * Load manufacturer mappings from Supabase
 */
async function loadManufacturerMappings() {
    try {
        console.log('[MfrMappings] Loading manufacturer mappings from Supabase...');
        const response = await fetch(`${SUPABASE_URL}/rest/v1/manufacturer_mappings?select=*&order=canonical_name`, {
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to load mappings: ${response.status}`);
        }

        state.manufacturerMappingsData = await response.json();
        console.log(`[MfrMappings] Loaded ${state.manufacturerMappingsData.length} mappings`);
    } catch (error) {
        console.error('[MfrMappings] Error loading mappings:', error);
        state.manufacturerMappingsData = [];
    }
}

/**
 * Toggle the manufacturer mappings panel visibility
 */
function toggleMfrMappingsPanel() {
    const panel = document.getElementById('mfrMappingsPanel');
    const btn = document.getElementById('mfrMappingsBtn');

    if (!panel) return;

    const isVisible = panel.style.display !== 'none';

    if (isVisible) {
        panel.style.display = 'none';
        btn?.classList.remove('active');
    } else {
        renderMfrMappingsTable();
        panel.style.display = 'block';
        btn?.classList.add('active');
    }
}

/**
 * Render the manufacturer mappings table
 */
function renderMfrMappingsTable() {
    const tbody = document.getElementById('mfrMappingsTableBody');
    const countSpan = document.getElementById('mfrMappingsCount');

    if (!tbody) return;

    // Update count
    if (countSpan) {
        countSpan.textContent = state.manufacturerMappingsData.length;
    }

    if (state.manufacturerMappingsData.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="4" style="text-align: center; color: var(--color-text-muted); padding: 12px;">
                    No manufacturer mappings found
                </td>
            </tr>
        `;
        return;
    }

    let html = '';
    state.manufacturerMappingsData.forEach(mapping => {
        const ingramAliases = (mapping.ingram_micro_aliases || []).join(', ') || '<span class="mfr-mappings-no-alias">--</span>';
        const tdsynnexAliases = (mapping.td_synnex_aliases || []).join(', ') || '<span class="mfr-mappings-no-alias">--</span>';
        const arrowAliases = (mapping.arrow_aliases || []).join(', ') || '<span class="mfr-mappings-no-alias">--</span>';

        html += `
            <tr>
                <td>${escapeHtml(mapping.canonical_name)}</td>
                <td>${ingramAliases}</td>
                <td>${tdsynnexAliases}</td>
                <td>${arrowAliases}</td>
            </tr>
        `;
    });

    tbody.innerHTML = html;
}

/**
 * Initialize vertical resize for mappings panel
 */
function initMfrMappingsResize() {
    const resizeHandle = document.getElementById('mfrMappingsResize');
    const container = document.getElementById('mfrMappingsTableContainer');

    if (!resizeHandle || !container) return;

    let isResizing = false;
    let startY = 0;
    let startHeight = 0;

    resizeHandle.addEventListener('mousedown', (e) => {
        isResizing = true;
        startY = e.clientY;
        startHeight = container.offsetHeight;
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const deltaY = e.clientY - startY;
        const newHeight = Math.max(80, Math.min(400, startHeight + deltaY));
        container.style.maxHeight = newHeight + 'px';
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        }
    });
}

async function submitQueue() {
    console.log('[SubmitQueue] Function called');

    if (state.queuedProducts.length === 0) {
        showStatus('No products in queue', 'error');
        return;
    }

    showStatus('Checking manufacturer mappings...', 'loading');
    console.log(`[SubmitQueue] Processing ${state.queuedProducts.length} products`);

    // Step 1: Extract unique manufacturers from queued products
    const uniqueManufacturers = new Map();
    for (const product of state.queuedProducts) {
        const mfr = product.vendorName || state.manufacturer;
        const distributor = product._source === 'tdsynnex' ? 'tdsynnex' : 'ingram';
        if (mfr && !uniqueManufacturers.has(mfr)) {
            uniqueManufacturers.set(mfr, distributor);
        }
    }
    console.log('[SubmitQueue] Unique manufacturers:', Array.from(uniqueManufacturers.keys()));

    // Step 2: Check mappings in batch via Supabase RPC
    const manufacturerList = Array.from(uniqueManufacturers.entries()).map(([name, distributor]) => ({
        name: name,
        distributor: distributor
    }));

    let mappingResults = [];
    try {
        mappingResults = await checkManufacturerMappingsBatch(manufacturerList);
    } catch (error) {
        console.error('[SubmitQueue] Error checking mappings:', error);
        showStatus('Error checking manufacturer mappings: ' + error.message, 'error');
        return;
    }

    // Step 3: Separate resolved vs. unresolved
    const normalizedMap = new Map();
    const unresolvedList = [];

    for (const result of mappingResults) {
        // RPC returns: distributor_name, distributor_source, found, canonical_name, suggested_name
        if (result.found) {
            normalizedMap.set(result.distributor_name, result.canonical_name);
        } else {
            unresolvedList.push({
                distributorName: result.distributor_name,
                distributor: result.distributor_source
            });
        }
    }

    console.log('[SubmitQueue] Resolved:', Object.fromEntries(normalizedMap));
    console.log('[SubmitQueue] Unresolved:', unresolvedList);

    // Step 4: If any unresolved, show resolution panel and wait
    if (unresolvedList.length > 0) {
        console.log('[SubmitQueue] Showing resolution panel for', unresolvedList.length, 'manufacturers');

        // Check if we have pre-fetched manufacturers
        if (state.prefetchedManufacturers.length === 0) {
            showStatus('Warning: No Zoho manufacturers available. You may only create new names.', 'info');
        }

        try {
            // Wait for user to resolve all manufacturers
            const userResolutions = await showMfrResolutionPanel(unresolvedList);

            // Merge user resolutions into normalizedMap
            for (const [distributorName, canonicalName] of userResolutions) {
                normalizedMap.set(distributorName, canonicalName);
            }

            console.log('[SubmitQueue] After resolution, normalizedMap:', Object.fromEntries(normalizedMap));
        } catch (error) {
            // User cancelled
            console.log('[SubmitQueue] Resolution cancelled by user');
            return;
        }
    }

    // Step 5: Format products with normalized manufacturers
    showStatus('Preparing products for submission...', 'loading');

    const productsWithMissingMfr = [];

    const formattedProducts = state.queuedProducts.map(product => {
        const pricingData = product.pricingData || state.pricingData?.[product.ingramPartNumber] || {};
        const msrp = pricingData?.pricing?.retailPrice || product.retailPrice || null;
        const originalMfr = product.vendorName || state.manufacturer;
        const normalizedMfr = normalizedMap.get(originalMfr) || originalMfr;

        // Defensive check: Track products with missing manufacturer
        if (!normalizedMfr) {
            const sku = product.vendorPartNumber || product.ingramPartNumber || 'Unknown SKU';
            console.error(`[SubmitQueue] Missing manufacturer for product: ${sku}`, {
                vendorName: product.vendorName,
                stateManufacturer: state.manufacturer,
                originalMfr,
                normalizedMfr,
                product
            });
            productsWithMissingMfr.push(sku);
        }

        // TD Synnex format
        if (product._source === 'tdsynnex') {
            return {
                Product_Code: product.vendorPartNumber || '',
                Product_Name: product.description || '',
                Manufacturer: normalizedMfr,
                TDSynnex_SKU: product.tdSynnexSkuNumber || '',
                MSRP: msrp,
                Customer_Price: pricingData?.pricing?.customerPrice || product.contract_price || product.unit_cost || null,
                Category_Level_1: product.category || state.category || '',
                Category_Level_2: product.subCategory || state.subcategory || '',
                Category_Level_3: product.cat3 || state.cat3 || '',
                UPC: product.upcCode || '',
                Description: product.extraDescription || '',
                Last_Sync_Source: 'TD SYNNEX',
                UNSPSC_Commodity: product.commodityName || '',
                Kit_or_Standalone: product.kitStandaloneFlag === 'K' ? 'Yes' : 'No',
                Quantity: 1
            };
        }

        // Ingram Micro format (default)
        return {
            Product_Code: product.vendorPartNumber || '',
            Product_Name: product.description || '',
            Manufacturer: normalizedMfr,
            Ingram_Micro_SKU: product.ingramPartNumber || '',
            MSRP: msrp,
            Customer_Price: pricingData?.pricing?.customerPrice || null,
            Category: product.category || state.category || '',
            Subcategory: product.subCategory || state.subcategory || '',
            UPC: pricingData?.upc || product.upcCode || '',
            Description: product.extraDescription || pricingData?.description || '',
            Last_Sync_Source: 'Ingram Micro',
            IM_Product_Type: product.productType || '',
            Kit_or_Standalone: pricingData?.bundlePartIndicator ? 'Yes' : 'No',
            Quantity: 1
        };
    });

    console.log('[SubmitQueue] Formatted products:', formattedProducts);
    console.log('[SubmitQueue] Manufacturer values:', formattedProducts.map(p => p.Manufacturer));

    // Prevent submission if any products have missing manufacturer
    if (productsWithMissingMfr.length > 0) {
        const errorMsg = `Cannot submit: Missing manufacturer for SKU(s): ${productsWithMissingMfr.join(', ')}. Please try re-searching for these products.`;
        console.error('[SubmitQueue] Aborting submission due to missing manufacturers:', productsWithMissingMfr);
        showStatus(errorMsg, 'error');
        return;
    }

    // Step 6: Submit to Zoho
    if (typeof $Client !== 'undefined') {
        console.log('[SubmitQueue] Calling $Client.close...');
        $Client.close({
            products: formattedProducts,
            distributor: state.currentDistributor
        });
    } else {
        console.log('[SubmitQueue] Standalone mode - would send:', formattedProducts);
        showStatus(`Queued ${formattedProducts.length} products (standalone mode)`, 'info');
    }
}

// =====================================================
// BATCH PRICING (fallback)
// =====================================================
async function fetchBatchPricing(products) {
    const partNumbers = products
        .map(p => p.ingramPartNumber)
        .filter(pn => pn);

    if (partNumbers.length === 0) return;

    try {
        const response = await fetch(`${PROXY_BASE}?action=pricing`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ partNumbers, sandbox: false })
        });

        const data = await response.json();
        state.pricingData = {};

        if (Array.isArray(data)) {
            data.forEach(item => {
                state.pricingData[item.ingramPartNumber] = item;
            });
        }
    } catch (error) {
        console.error('[Pricing] Error:', error);
    }
}

// =====================================================
// PRODUCT DETAILS
// =====================================================
async function showProductDetails(productIndex) {
    const product = state.currentProducts[productIndex];
    if (!product) {
        console.error('Product not found at index:', productIndex);
        return;
    }

    const isTDSynnex = product._source === 'tdsynnex';
    console.log(`[Details] Loading details for ${product.vendorPartNumber} (${isTDSynnex ? 'TD SYNNEX' : 'Ingram'})...`);

    const detailsSection = document.getElementById('productDetailsSection');
    detailsSection.style.display = 'block';
    detailsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // Reset raw API visibility
    state.rawApiVisible = false;
    const rawContainer = document.getElementById('rawApiContainer');
    const rawToggle = document.getElementById('rawApiToggle');
    if (rawContainer) rawContainer.style.display = 'none';
    if (rawToggle) rawToggle.classList.remove('active');

    // Helper functions (shared between distributors)
    const yesNo = (val) => {
        if (val === true) return 'Yes';
        if (val === false) return 'No';
        if (typeof val === 'string') {
            const lower = val.toLowerCase();
            if (lower === 'true' || lower === 'yes') return 'Yes';
            if (lower === 'false' || lower === 'no') return 'No';
        }
        return '-';
    };

    const formatCurrency = (val) => {
        if (val === null || val === undefined) return '-';
        return `$${Number(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    };

    const renderGrid = (elementId, fields) => {
        const grid = document.getElementById(elementId);
        if (grid) {
            grid.innerHTML = fields.map(f => `
                <div class="field-mapping-item">
                    <span class="field-label">${f.label}</span>
                    <span class="field-value">${f.value}</span>
                </div>
            `).join('');
        }
    };

    const renderGridWithOptions = (elementId, fields) => {
        const grid = document.getElementById(elementId);
        if (grid) {
            grid.innerHTML = fields.map(f => `
                <div class="field-mapping-item${f.fullWidth ? ' full-width' : ''}">
                    <span class="field-label">${f.label}</span>
                    <span class="field-value">${f.value}</span>
                </div>
            `).join('');
        }
    };

    const renderFlagsGrid = (elementId, fields) => {
        const grid = document.getElementById(elementId);
        if (grid) {
            grid.innerHTML = fields.map(f => `
                <div class="field-mapping-item">
                    <span class="field-label">${f.label}</span>
                    <span class="field-value">${f.isHtml ? f.value : f.value}</span>
                </div>
            `).join('');
        }
    };

    // ========================================
    // TD SYNNEX PRODUCT DETAILS
    // ========================================
    if (isTDSynnex) {
        // Access raw product data for TD SYNNEX fields
        const rawProduct = product._rawProduct || {};
        let warehouseData = { warehouses: [], totalQty: 0, totalOnOrder: 0, status: null };

        // Fetch warehouse availability from TD SYNNEX XML API using numeric SKU (Field 5)
        if (product.tdSynnexSkuNumber) {
            warehouseData = await fetchTDSynnexWarehouseAvailability(product.tdSynnexSkuNumber);
        }

        const fullProductData = { ...product, warehouseData };

        // Determine authorization status from API response
        const isNotAuthorized = warehouseData.status === 'Notauthorized';
        const authorizedText = isNotAuthorized ? 'No' : 'Yes';
        const authorizedClass = isNotAuthorized ? 'authorized-no' : 'authorized-yes';

        // Header - Product Name (from part_description)
        document.getElementById('detailsProductName').innerHTML = `
            <strong>Product Name:</strong> ${product.description || 'N/A'}
        `;

        // Header - TD Synnex SKU (Field 5), Vendor Part (manufacturer_part_number), Manufacturer, Authorized
        document.getElementById('detailsSubtitle').innerHTML = `
            <strong>TD Synnex SKU:</strong> ${product.tdSynnexSkuNumber || 'N/A'} |
            <strong>Vendor Part:</strong> ${product.vendorPartNumber || 'N/A'} |
            <strong>Manufacturer:</strong> ${product.vendorName || state.manufacturer} |
            <strong>Authorized:</strong> <span class="${authorizedClass}">${authorizedText}</span>
        `;

        // Long Description (from long_description)
        const longDesc = product.extraDescription || '';
        const longDescEl = document.getElementById('detailsLongDesc');
        if (longDesc) {
            longDescEl.innerHTML = `<strong>Long Description:</strong> ${longDesc}`;
            longDescEl.style.display = 'block';
        } else {
            longDescEl.style.display = 'none';
        }

        // Product Information Grid - TD SYNNEX specific labels
        // Category 1 = cat_description_1, Category 2 = cat_description_2, Category 3 = cat_description_3
        // SKU Type = derived from Fields 28,53,54,55 (weight/dimensions)
        // UNSPSC = commodity_name
        // Replacement SKU = replacement_sku
        const productInfoFields = [
            { label: 'Category 1', value: product.category || '-' },
            { label: 'Category 2', value: product.subCategory || '-' },
            { label: 'Category 3', value: product.cat3 || '-' },
            { label: 'SKU Type', value: product.skuType || '-' },
            { label: 'UNSPSC', value: product.commodityName || '-' },
            { label: 'Replacement SKU', value: product.replacementSku || '-' }
        ];
        renderGrid('productInfoGrid', productInfoFields);

        // Pricing Grid - TD SYNNEX: MSRP from msrp, Customer Price from contract_price
        // Using pricingData.pricing which is set in mapTDSynnexProduct from raw fields
        const pricingFields = [
            { label: 'MSRP', value: formatCurrency(product.pricingData?.pricing?.retailPrice) },
            { label: 'Customer Price', value: formatCurrency(product.pricingData?.pricing?.customerPrice) },
            { label: 'Regular Price', value: formatCurrency(product.unitCost) }
        ];
        renderGrid('pricingGrid', pricingFields);

        // Availability Grid - use API response if available, else flat file data (qty_total)
        const apiTotalQty = warehouseData.totalQty;
        const flatFileTotalQty = product.pricingData?.availability?.totalAvailability ?? 0;
        const displayQty = apiTotalQty > 0 ? apiTotalQty : flatFileTotalQty;
        const inStock = displayQty > 0;

        const availabilityFields = [
            { label: 'In Stock', value: yesNo(inStock) },
            { label: 'Available Qty', value: displayQty === 9999 ? 'Unlimited' : displayQty }
        ];
        renderGrid('availabilityGrid', availabilityFields);

        // Flags Grid - TD SYNNEX specific derivation
        // Digital = SKU Type derived from weight/dimensions
        // Bundle = kit_standalone_flag = "K"
        // Licensed = td_assigned_use (Field 36) contains "License"
        // Service SKU = cat_description_1 = "Service / Support" OR cat_description_2 contains "Service"/"Support"
        // Direct Ship = sku_attributes first char is "Y"
        // New = sku_created_date (Field 37) <= 90 days
        // Discontinued = abc_code = "C" or "T"
        const discontinuedValue = product.isDiscontinued
            ? '<span class="discontinued-yes">Yes</span>'
            : '<span class="discontinued-no">No</span>';

        const flagsFields = [
            { label: 'Digital', value: yesNo(product.isDigital) },
            { label: 'Bundle', value: yesNo(product.kitStandaloneFlag === 'K') },
            { label: 'Licensed', value: yesNo(product.isLicensed) },
            { label: 'Service SKU', value: yesNo(product.isServiceSku) },
            { label: 'Direct Ship', value: yesNo(product.skuAttributes?.charAt(0) === 'Y') },
            { label: 'New', value: yesNo(product.isNew) },
            { label: 'Discontinued', value: discontinuedValue, isHtml: true }
        ];
        renderFlagsGrid('flagsGrid', flagsFields);

        // Discounts - TD SYNNEX: show only if promo_flag = "Y"
        // Type = "Rebate" (static), Bid Number = "N/A" (static)
        // Discount = unit_cost - contract_price
        // Qty = 99999 (static), Effective = "N/A" (static), Expires = promo_expiration
        const discountsGroup = document.getElementById('discountsGroup');
        const discountsBody = document.getElementById('discountsBody');

        if (product.promoFlag === 'Y') {
            discountsGroup.style.display = 'block';
            // Discount = unit_cost - contract_price (from raw fields via mapped properties)
            const discountAmount = (product.unitCost && product.contractPrice)
                ? product.unitCost - product.contractPrice
                : null;
            discountsBody.innerHTML = `
                <tr>
                    <td>Rebate</td>
                    <td>N/A</td>
                    <td class="text-right">${formatCurrency(discountAmount)}</td>
                    <td class="text-right">99999</td>
                    <td>N/A</td>
                    <td>${formatPromoDate(product.promoExpiration)}</td>
                </tr>
            `;
        } else {
            discountsGroup.style.display = 'none';
        }

        // Warehouse Availability - from TD SYNNEX XML API response
        // Warehouse = WHS-001 (number), Location = WHS-003 (city)
        // Available = WHS-005 (qty), Backordered = WHS-006 (onOrderQuantity)
        const warehouseSection = document.getElementById('warehouseSection');
        const warehouseBody = document.getElementById('warehouseBody');

        // Only show warehouse card when In Stock (qty > 0)
        const availableWarehouses = (warehouseData.warehouses || []).filter(wh => (wh.qty ?? 0) > 0);

        if (availableWarehouses.length > 0) {
            warehouseSection.style.display = 'block';
            warehouseBody.innerHTML = availableWarehouses.map(wh => `
                <tr>
                    <td>${wh.warehouseId || wh.number || '-'}</td>
                    <td>${wh.city || '-'}</td>
                    <td class="text-right">${wh.qty ?? 0}</td>
                    <td class="text-right">${wh.onOrder ?? wh.onOrderQuantity ?? 0}</td>
                </tr>
            `).join('');
        } else {
            warehouseSection.style.display = 'none';
        }

        document.getElementById('rawApiResponse').textContent = JSON.stringify(fullProductData, null, 2);
        return;
    }

    // ========================================
    // INGRAM MICRO PRODUCT DETAILS
    // ========================================
    const ingramPn = product.ingramPartNumber;
    let pricingData = state.pricingData?.[ingramPn];
    let productDetails = null;

    if (ingramPn) {
        const fetchPromises = [];

        if (!pricingData) {
            fetchPromises.push(
                fetch(`${PROXY_BASE}?action=pricing`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ partNumbers: [ingramPn], sandbox: false })
                })
                .then(res => res.json())
                .then(data => {
                    if (Array.isArray(data) && data.length > 0) {
                        pricingData = data[0];
                        state.pricingData[ingramPn] = pricingData;
                    }
                })
                .catch(err => console.error('[Details] Error fetching pricing:', err))
            );
        }

        fetchPromises.push(
            fetch(`${PROXY_BASE}?action=productDetails&ingramPartNumber=${encodeURIComponent(ingramPn)}`)
                .then(res => res.json())
                .then(data => {
                    if (data && !data.error) {
                        productDetails = data;
                    }
                })
                .catch(err => console.error('[Details] Error fetching product details:', err))
        );

        await Promise.all(fetchPromises);
    }

    const fullProductData = { ...product, pricingData, productDetails };

    const isAuthorized = product.authorizedToPurchase === 'true' ||
                         product.authorizedToPurchase === true ||
                         pricingData?.productAuthorized === true;
    const authorizedText = isAuthorized ? 'Yes' : 'No';
    const authorizedClass = isAuthorized ? 'authorized-yes' : 'authorized-no';

    // Row 1: Product Name
    document.getElementById('detailsProductName').innerHTML = `
        <strong>Product Name:</strong> ${product.description || 'N/A'}
    `;
    // Row 2: Ingram SKU, Vendor Part, Manufacturer, Authorized
    document.getElementById('detailsSubtitle').innerHTML = `
        <strong>Ingram SKU:</strong> ${ingramPn || 'N/A'} |
        <strong>Vendor Part:</strong> ${product.vendorPartNumber || 'N/A'} |
        <strong>Manufacturer:</strong> ${product.vendorName || state.manufacturer} |
        <strong>Authorized:</strong> <span class="${authorizedClass}">${authorizedText}</span>
    `;

    const longDesc = product.extraDescription || pricingData?.description || '';
    const longDescEl = document.getElementById('detailsLongDesc');
    if (longDesc) {
        longDescEl.innerHTML = `<strong>Long Description:</strong> ${longDesc}`;
        longDescEl.style.display = 'block';
    } else {
        longDescEl.style.display = 'none';
    }

    // Ingram: Category, Subcategory, Product Type, SKU Type, Product Class, Replacement SKU
    const productInfoFields = [
        { label: 'Category', value: product.category || state.category || '-' },
        { label: 'Subcategory', value: product.subCategory || state.subcategory || '-' },
        { label: 'Product Type', value: product.productType || '-' },
        { label: 'SKU Type', value: formatSKUType(product.type) },
        { label: 'Product Class', value: formatProductClass(pricingData?.productClass || product.productClass), fullWidth: true },
        { label: 'Replacement SKU', value: product.replacementSku || '-', fullWidth: true }
    ];
    renderGridWithOptions('productInfoGrid', productInfoFields);

    // Ingram pricing: MSRP (retailPrice) and Customer Price (customerPrice) - no Subscription Price
    const msrpValue = formatCurrency(pricingData?.pricing?.retailPrice);
    const customerPriceValue = formatCurrency(pricingData?.pricing?.customerPrice);

    // Calculate Regular Price = Customer Price + sum of all discounts
    const customerPrice = pricingData?.pricing?.customerPrice || 0;
    let totalDiscounts = 0;
    if (pricingData?.discounts && Array.isArray(pricingData.discounts)) {
        pricingData.discounts.forEach(discountGroup => {
            if (discountGroup.specialPricing && Array.isArray(discountGroup.specialPricing)) {
                discountGroup.specialPricing.forEach(sp => {
                    if (sp.specialPricingDiscount) {
                        totalDiscounts += parseFloat(sp.specialPricingDiscount) || 0;
                    }
                });
            }
        });
    }
    const regularPrice = customerPrice + totalDiscounts;

    const pricingFields = [
        { label: 'MSRP', value: msrpValue },
        { label: 'Customer Price', value: customerPriceValue },
        { label: 'Regular Price', value: formatCurrency(regularPrice) }
    ];
    renderGrid('pricingGrid', pricingFields);

    // Ingram discounts
    const discountsGroup = document.getElementById('discountsGroup');
    const discountsBody = document.getElementById('discountsBody');

    let allDiscounts = [];
    if (pricingData?.discounts && Array.isArray(pricingData.discounts)) {
        pricingData.discounts.forEach(discountGroup => {
            if (discountGroup.specialPricing && Array.isArray(discountGroup.specialPricing)) {
                allDiscounts.push(...discountGroup.specialPricing);
            }
        });
    }

    if (allDiscounts.length > 0) {
        discountsGroup.style.display = 'block';
        discountsBody.innerHTML = allDiscounts.map(d => `
            <tr>
                <td>${d.discountType || '-'}</td>
                <td>${d.specialBidNumber || '-'}</td>
                <td class="text-right">${formatCurrency(d.specialPricingDiscount)}</td>
                <td class="text-right">${d.specialPricingAvailableQuantity ?? '-'}</td>
                <td>${d.specialPricingEffectiveDate || '-'}</td>
                <td>${d.specialPricingExpirationDate || '-'}</td>
            </tr>
        `).join('');
    } else {
        discountsGroup.style.display = 'none';
    }

    const availabilityFields = [
        { label: 'In Stock', value: yesNo(pricingData?.availability?.available) },
        { label: 'Available Qty', value: pricingData?.availability?.totalAvailability ?? '-' }
    ];
    renderGrid('availabilityGrid', availabilityFields);

    const indicators = productDetails?.indicators || {};

    // Discontinued badge with color
    const isDiscontinued = product.discontinued || indicators.isDiscontinuedProduct;
    const discontinuedValue = isDiscontinued === true || isDiscontinued === 'true'
        ? '<span class="discontinued-yes">Yes</span>'
        : '<span class="discontinued-no">No</span>';

    // Ingram flags
    const flagsFields = [
        { label: 'Digital', value: yesNo(indicators.isDigitalType || product.type === 'IM::Digital' || product.type === 'IM::digital') },
        { label: 'Bundle', value: yesNo(indicators.hasBundle || pricingData?.bundlePartIndicator) },
        { label: 'Licensed', value: yesNo(indicators.isLicenseProduct) },
        { label: 'Service SKU', value: yesNo(indicators.isServiceSku) },
        { label: 'Direct Ship', value: yesNo(product.directShip || indicators.isDirectship) },
        { label: 'New', value: yesNo(product.newProduct || indicators.isNewProduct) },
        { label: 'Discontinued', value: discontinuedValue, isHtml: true }
    ];
    renderFlagsGrid('flagsGrid', flagsFields);

    // Ingram warehouse availability
    const warehouseSection = document.getElementById('warehouseSection');
    const warehouseBody = document.getElementById('warehouseBody');

    const totalAvailability = pricingData?.availability?.totalAvailability ?? 0;

    if (totalAvailability > 0 && pricingData?.availability?.availabilityByWarehouse?.length > 0) {
        const availableWarehouses = pricingData.availability.availabilityByWarehouse
            .filter(wh => (wh.quantityAvailable ?? 0) > 0);

        if (availableWarehouses.length > 0) {
            warehouseSection.style.display = 'block';
            warehouseBody.innerHTML = availableWarehouses.map(wh => `
                <tr>
                    <td>${wh.warehouseId}</td>
                    <td>${wh.location || '-'}</td>
                    <td class="text-right">${wh.quantityAvailable ?? 0}</td>
                    <td class="text-right">${wh.quantityBackordered ?? 0}</td>
                </tr>
            `).join('');
        } else {
            warehouseSection.style.display = 'none';
        }
    } else {
        warehouseSection.style.display = 'none';
    }

    document.getElementById('rawApiResponse').textContent = JSON.stringify(fullProductData, null, 2);
}

function hideProductDetails() {
    document.getElementById('productDetailsSection').style.display = 'none';
}

// =====================================================
// ACTION HANDLERS (Legacy support)
// =====================================================
function addSelectedProducts() {
    // Legacy function - now redirects to queue workflow
    addSelectedToQueue();
}

function cancelSelection() {
    console.log('Cancel clicked');

    if (typeof $Client !== 'undefined') {
        $Client.close({ cancelled: true, products: [] });
    }

    state.selectedProducts.clear();
    state.queuedProducts = [];
    updateSelectedCount();
    updateQueueUI();
}

// =====================================================
// UTILITY FUNCTIONS
// =====================================================
function resetFilters() {
    state.manufacturer = '';
    state.currentPage = 1;
    state.totalRecords = 0;
    state.totalPages = 1;

    // Reset SKU search mode
    state.skuSearchMode = false;
    state.pendingSkuFilter = '';
    state.skuManufacturerOptions = [];

    document.getElementById('manufacturerSearch').value = '';
    document.getElementById('manufacturerSelect').innerHTML =
        '<option value="">Type to search manufacturers...</option>';
    document.getElementById('mfrCount').textContent = '';
    document.getElementById('selectedMfrBadge').textContent = '';

    // Clear SKU search input and reset placeholder
    const skuSearch = document.getElementById('skuSearch');
    const skuSearchRow = document.getElementById('skuSearchRow');
    if (skuSearch) {
        skuSearch.value = '';
        skuSearch.placeholder = 'Enter partial or full SKU (e.g. AB123, XYZ-456)...';
    }
    if (skuSearchRow) {
        skuSearchRow.classList.remove('filter-mode');
    }

    // Show OR divider
    const orDivider = document.getElementById('orDivider');
    if (orDivider) {
        orDivider.classList.remove('hidden');
    }

    document.getElementById('optionalFiltersRow').style.display = 'none';

    resetOptionalFilters();
    resetProducts();

    document.getElementById('productsSection').style.display = 'none';
    showStatus('Select a manufacturer or enter a SKU to begin', 'info');
}

function resetOptionalFilters() {
    state.category = '';
    state.subcategory = '';
    state.cat3 = '';
    state.skuType = '';
    state.skuKeyword = '';

    state.filterParams.category = '';
    state.filterParams.subcategory = '';
    state.filterParams.cat3 = '';

    const catSelect = document.getElementById('categorySelect');
    if (catSelect) {
        catSelect.innerHTML = '<option value="">-- Any --</option>';
        document.getElementById('catCount').textContent = '';
    }

    const subSelect = document.getElementById('subcategorySelect');
    if (subSelect) {
        subSelect.innerHTML = '<option value="">-- Any --</option>';
        document.getElementById('subCatCount').textContent = '';
    }

    const cat3Select = document.getElementById('cat3Select');
    if (cat3Select) {
        cat3Select.innerHTML = '<option value="">-- Any --</option>';
        document.getElementById('cat3Count').textContent = '';
    }

    const skuTypeSelect = document.getElementById('skuTypeSelect');
    if (skuTypeSelect) {
        skuTypeSelect.value = '';
    }

    const skuSearch = document.getElementById('skuSearch');
    if (skuSearch) {
        skuSearch.value = '';
    }
}

function resetProducts() {
    document.getElementById('productsBody').innerHTML = '';
    document.getElementById('pagination').innerHTML = '';
    document.getElementById('productCount').textContent = '0 products';
    document.getElementById('productDetailsSection').style.display = 'none';

    // Only clear current page selection, NOT the queue
    state.selectedProducts.clear();
    state.currentProducts = [];
    state.pricingData = {};

    updateSelectedCount();

    // Reset select all checkbox
    const selectAll = document.getElementById('selectAll');
    if (selectAll) selectAll.checked = false;
}

let statusTimeout = null;

function showStatus(message, type) {
    const el = document.getElementById('filterStatus');
    if (!el) return;

    // Clear any existing timeout
    if (statusTimeout) {
        clearTimeout(statusTimeout);
        statusTimeout = null;
    }

    el.className = `status-bar ${type}`;
    el.innerHTML = `<span class="status-message">${message}</span>`;

    if (!message) {
        el.style.display = 'none';
    } else {
        el.style.display = 'flex';

        // Auto-dismiss success and info messages after 10 seconds
        if (type === 'success' || type === 'info') {
            statusTimeout = setTimeout(() => {
                el.style.display = 'none';
            }, 10000);
        }
    }
}