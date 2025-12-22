/**
 * Distributor Product Lookup Widget
 * For Zoho CRM Quotes module integration
 */

// =====================================================
// CONFIGURATION
// =====================================================
// Supabase Edge Function URL for Ingram Micro API proxy
const PROXY_BASE = 'https://tydxdpntshbobomemzxj.supabase.co/functions/v1/ingram-proxy';
const PAGE_SIZE = 50;

// Distributor configurations
const DISTRIBUTORS = {
    ingram: {
        name: 'Ingram Micro',
        apiPrefix: '/api',
        color: '#0066cc'
    },
    tdsynnex: {
        name: 'TD SYNNEX',
        apiPrefix: '/tdsynnex',
        color: '#00a550',
        disabled: true // Will be enabled when TD SYNNEX API is integrated
    }
};

// =====================================================
// STATE MANAGEMENT
// =====================================================
const state = {
    currentDistributor: 'ingram',
    manufacturer: '',
    category: '',
    subcategory: '',
    currentPage: 1,
    selectedProducts: new Map(), // Map of partNumber -> product
    isAuthenticated: false,
    pendingResponseId: null, // For NotifyAndWait response
    parentContext: null,
    currentProducts: [], // Products currently displayed
    pricingData: {} // Cached pricing data by ingramPartNumber
};

let searchTimeout = null;

// =====================================================
// ZOHO SDK INITIALIZATION
// =====================================================
document.addEventListener('DOMContentLoaded', function() {
    console.log('Widget DOM loaded, initializing Zoho SDK...');
    initZohoSDK();
    initEventListeners();
    checkProxyStatus();
});

function initZohoSDK() {
    // Check if ZOHO SDK is available
    if (typeof ZOHO === 'undefined') {
        console.warn('ZOHO SDK not loaded. Running in standalone mode.');
        showStatus('Running in standalone mode (Zoho SDK not available)', 'info');
        return;
    }

    // Initialize the embedded app
    ZOHO.embeddedApp.init();
    console.log('ZOHO.embeddedApp.init() called');

    // Note: Using openPopup with width/height parameters instead of Resize()
    // ZOHO.CRM.UI.Resize() was causing issues with popup context

    // Handle PageLoad event - receives initial context
    ZOHO.embeddedApp.on("PageLoad", function(data) {
        console.log('PageLoad event received:', data);
        state.parentContext = data;
        showStatus('Widget loaded. Select a manufacturer to begin.', 'info');
    });

    // Handle NotifyAndWait event - Client Script is waiting for response
    ZOHO.embeddedApp.on("NotifyAndWait", function(data) {
        console.log('NotifyAndWait event received:', data);
        state.pendingResponseId = data.id;
        state.parentContext = data.data || {};
        showStatus('Ready to search. Select products and click "Add Selected".', 'info');
    });
}

// =====================================================
// EVENT LISTENERS
// =====================================================
function initEventListeners() {
    // Manufacturer search with debounce
    const mfrSearch = document.getElementById('manufacturerSearch');
    if (mfrSearch) {
        mfrSearch.addEventListener('input', debounceManufacturerSearch);
    }

    // Select all checkbox
    const selectAll = document.getElementById('selectAll');
    if (selectAll) {
        selectAll.addEventListener('change', toggleSelectAll);
    }
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

    // Update button states
    document.querySelectorAll('.distributor-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.distributor === distributor);
    });

    // Reset filters
    resetFilters();
    showStatus(`Switched to ${DISTRIBUTORS[distributor].name}. Search for a manufacturer.`, 'info');
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
            showStatus('Proxy server not configured. Check .env.local credentials.', 'error');
        }
    } catch (error) {
        indicator.classList.remove('connected');
        statusText.textContent = 'Proxy offline';
        showStatus('Start proxy server: node ingram-proxy-server.js', 'error');
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
// MANUFACTURER SEARCH (Type-ahead)
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
        const response = await fetch(
            `${PROXY_BASE}?action=manufacturers&search=${encodeURIComponent(searchTerm)}`
        );
        const data = await response.json();

        select.innerHTML = '<option value="">-- Select a manufacturer --</option>';

        if (data.manufacturers && data.manufacturers.length > 0) {
            data.manufacturers.forEach(mfr => {
                const option = document.createElement('option');
                option.value = mfr;
                option.textContent = mfr;
                select.appendChild(option);
            });
            document.getElementById('mfrCount').textContent = `(${data.manufacturers.length})`;
            showStatus(`Found ${data.manufacturers.length} manufacturers`, 'success');
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
// CATEGORY LOADING
// =====================================================
async function onManufacturerSelect() {
    const select = document.getElementById('manufacturerSelect');
    state.manufacturer = select.value;

    // Reset downstream
    resetCategory();
    resetSubcategory();
    resetProducts();

    if (!state.manufacturer) {
        document.getElementById('categorySelect').disabled = true;
        return;
    }

    showStatus(`Loading categories for ${state.manufacturer}...`, 'loading');
    document.getElementById('categorySelect').innerHTML = '<option value="">Loading...</option>';

    try {
        const response = await fetch(
            `${PROXY_BASE}?action=categories&vendor=${encodeURIComponent(state.manufacturer)}`
        );
        const data = await response.json();

        const catSelect = document.getElementById('categorySelect');
        catSelect.innerHTML = '<option value="">-- All Categories --</option>';

        if (data.categories && data.categories.length > 0) {
            data.categories.forEach(cat => {
                const option = document.createElement('option');
                option.value = cat;
                option.textContent = cat;
                catSelect.appendChild(option);
            });
            catSelect.disabled = false;
            document.getElementById('catCount').textContent = `(${data.categories.length})`;
            document.getElementById('loadProductsBtn').disabled = false;
            showStatus(`${data.categories.length} categories. Select one or click Load Products.`, 'success');
        } else {
            catSelect.innerHTML = '<option value="">No categories found</option>';
            showStatus('No categories found for this manufacturer.', 'info');
        }
    } catch (error) {
        showStatus('Error loading categories: ' + error.message, 'error');
    }
}

// =====================================================
// SUBCATEGORY LOADING
// =====================================================
async function onCategorySelect() {
    const select = document.getElementById('categorySelect');
    state.category = select.value;

    // Reset downstream
    resetSubcategory();
    resetProducts();

    if (!state.category) {
        document.getElementById('subcategorySelect').disabled = true;
        return;
    }

    showStatus(`Loading subcategories for ${state.category}...`, 'loading');
    document.getElementById('subcategorySelect').innerHTML = '<option value="">Loading...</option>';

    try {
        const response = await fetch(
            `${PROXY_BASE}?action=subcategories&vendor=${encodeURIComponent(state.manufacturer)}&category=${encodeURIComponent(state.category)}`
        );
        const data = await response.json();

        const subSelect = document.getElementById('subcategorySelect');
        subSelect.innerHTML = '<option value="">-- All Subcategories --</option>';

        if (data.subcategories && data.subcategories.length > 0) {
            data.subcategories.forEach(sub => {
                const option = document.createElement('option');
                option.value = sub;
                option.textContent = sub;
                subSelect.appendChild(option);
            });
            subSelect.disabled = false;
            document.getElementById('subCatCount').textContent = `(${data.subcategories.length})`;
            showStatus(`${data.subcategories.length} subcategories. Select one or click Load Products.`, 'success');
        } else {
            subSelect.innerHTML = '<option value="">No subcategories</option>';
        }
    } catch (error) {
        showStatus('Error loading subcategories: ' + error.message, 'error');
    }
}

function onSubcategorySelect() {
    state.subcategory = document.getElementById('subcategorySelect').value;
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
    showStatus('Loading products...', 'loading');

    try {
        let url = `${PROXY_BASE}?action=products&vendor=${encodeURIComponent(state.manufacturer)}&page=${page}`;
        if (state.category) url += `&category=${encodeURIComponent(state.category)}`;
        if (state.subcategory) url += `&subCategory=${encodeURIComponent(state.subcategory)}`;

        const response = await fetch(url);
        const data = await response.json();

        if (data.products && data.products.length > 0) {
            displayProducts(data.products, data.pagination);
            showStatus('', ''); // Clear status
        } else {
            document.getElementById('productsBody').innerHTML =
                '<tr><td colspan="6" class="no-results">No products found</td></tr>';
            document.getElementById('pagination').innerHTML = '';
            document.getElementById('productCount').textContent = '0 products';
            showStatus('No products found with current filters', 'info');
        }
    } catch (error) {
        showStatus('Error loading products: ' + error.message, 'error');
    }
}

function displayProducts(products, pagination) {
    const tbody = document.getElementById('productsBody');
    tbody.innerHTML = '';

    // Store products for batch pricing lookup
    state.currentProducts = products;

    products.forEach((product, index) => {
        const partNumber = product.ingramPartNumber || product.vendorPartNumber;
        const isSelected = state.selectedProducts.has(partNumber);

        const tr = document.createElement('tr');
        tr.className = isSelected ? 'selected' : '';
        tr.id = `product-row-${index}`;
        tr.innerHTML = `
            <td>
                <input type="checkbox"
                       onchange="toggleProduct('${partNumber}', this.checked)"
                       ${isSelected ? 'checked' : ''}>
            </td>
            <td><strong>${product.vendorPartNumber || '-'}</strong></td>
            <td>${(product.description || '-').substring(0, 40)}${(product.description || '').length > 40 ? '...' : ''}</td>
            <td>${product.vendorName || state.manufacturer}</td>
            <td>${product.ingramPartNumber || '-'}</td>
            <td class="price" id="msrp-${index}"><span class="price-loading">...</span></td>
            <td>
                <span class="info-icon" onclick="showProductDetails(${index})" title="Show product details">i</span>
            </td>
        `;
        tbody.appendChild(tr);

        // Store product data for later use
        tr.dataset.product = JSON.stringify(product);
    });

    // Update product count
    document.getElementById('productCount').textContent =
        `${pagination.totalRecords.toLocaleString()} products`;

    // Update pagination
    renderPagination(pagination);
    updateSelectedCount();

    // Fetch batch pricing after displaying products
    fetchBatchPricing(products);
}

function renderPagination(pagination) {
    const paginationDiv = document.getElementById('pagination');

    if (pagination.totalPages <= 1) {
        paginationDiv.innerHTML = '';
        return;
    }

    paginationDiv.innerHTML = `
        <button onclick="loadProducts(${pagination.page - 1})"
                ${pagination.page === 1 ? 'disabled' : ''} class="small">
            Previous
        </button>
        <span>Page ${pagination.page} of ${pagination.totalPages}</span>
        <button onclick="loadProducts(${pagination.page + 1})"
                ${pagination.page >= pagination.totalPages ? 'disabled' : ''} class="small">
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
    const checkboxes = document.querySelectorAll('#productsBody input[type="checkbox"]');

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
    document.getElementById('addSelectedBtn').disabled = count === 0;
}

// =====================================================
// BATCH PRICING (Option A)
// =====================================================
async function fetchBatchPricing(products) {
    // Get Ingram part numbers for batch lookup
    const partNumbers = products
        .map(p => p.ingramPartNumber)
        .filter(pn => pn); // Filter out empty/null values

    if (partNumbers.length === 0) {
        console.log('[Pricing] No Ingram part numbers to look up');
        return;
    }

    console.log(`[Pricing] Fetching prices for ${partNumbers.length} products...`);

    try {
        const response = await fetch(`${PROXY_BASE}?action=pricing`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                partNumbers: partNumbers,
                sandbox: false // Use production pricing
            })
        });

        const data = await response.json();
        console.log('[Pricing] Response:', data);

        // Store pricing data in state for later use
        state.pricingData = {};

        // Map pricing data back to products
        if (Array.isArray(data)) {
            data.forEach(item => {
                const ingramPn = item.ingramPartNumber;
                state.pricingData[ingramPn] = item;

                // Find product index and update display
                const productIndex = products.findIndex(p => p.ingramPartNumber === ingramPn);
                if (productIndex !== -1) {
                    const msrpEl = document.getElementById(`msrp-${productIndex}`);

                    if (msrpEl && item.pricing?.retailPrice) {
                        msrpEl.innerHTML = `<span class="price-available">$${item.pricing.retailPrice.toFixed(2)}</span>`;
                        // Update the stored product data with pricing
                        products[productIndex].retailPrice = item.pricing.retailPrice;
                    } else if (msrpEl) {
                        msrpEl.innerHTML = '<span class="price-unavailable">-</span>';
                    }

                    // Update the row's dataset with enriched product
                    const row = document.getElementById(`product-row-${productIndex}`);
                    if (row) {
                        const enrichedProduct = { ...products[productIndex], pricingData: item };
                        row.dataset.product = JSON.stringify(enrichedProduct);
                    }
                }
            });
        }

        console.log(`[Pricing] Updated ${Object.keys(state.pricingData).length} product prices`);

    } catch (error) {
        console.error('[Pricing] Error:', error);
        // Show "-" for all prices on error
        products.forEach((_, index) => {
            const msrpEl = document.getElementById(`msrp-${index}`);
            if (msrpEl) msrpEl.innerHTML = '<span class="price-unavailable">-</span>';
        });
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

    const ingramPn = product.ingramPartNumber;
    console.log(`[Details] Loading details for ${ingramPn}...`);

    // Show the details section
    const detailsSection = document.getElementById('productDetailsSection');
    detailsSection.style.display = 'block';

    // Scroll to details section
    detailsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // Get pricing data (from state or fetch fresh)
    let pricingData = state.pricingData?.[ingramPn];
    let fullProductData = product;

    // If no pricing data, try to fetch it
    if (!pricingData && ingramPn) {
        try {
            const response = await fetch(`${PROXY_BASE}?action=pricing`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    partNumbers: [ingramPn],
                    sandbox: false
                })
            });
            const data = await response.json();
            if (Array.isArray(data) && data.length > 0) {
                pricingData = data[0];
                state.pricingData[ingramPn] = pricingData;
                fullProductData = { ...product, pricingData };
            }
        } catch (error) {
            console.error('[Details] Error fetching pricing:', error);
        }
    } else if (pricingData) {
        fullProductData = { ...product, pricingData };
    }

    // Determine authorization status (from catalog search or pricing data)
    const isAuthorized = product.authorizedToPurchase === 'true' ||
                         product.authorizedToPurchase === true ||
                         pricingData?.productAuthorized === true;
    const authorizedText = isAuthorized ? 'Yes' : 'No';

    // Set title and subtitle
    document.getElementById('detailsTitle').textContent = product.description || 'No Description';
    document.getElementById('detailsSubtitle').innerHTML = `
        <strong>Ingram SKU:</strong> ${ingramPn || 'N/A'} |
        <strong>Vendor Part:</strong> ${product.vendorPartNumber || 'N/A'} |
        <strong>Manufacturer:</strong> ${product.vendorName || state.manufacturer} |
        <strong>Authorized:</strong> ${authorizedText}
    `;

    // Set long description (extraDescription from catalog or description from pricing)
    const longDesc = product.extraDescription || pricingData?.description || '';
    const longDescEl = document.getElementById('detailsLongDesc');
    if (longDesc) {
        longDescEl.innerHTML = `<strong>Long Description:</strong> ${longDesc}`;
        longDescEl.style.display = 'block';
    } else {
        longDescEl.style.display = 'none';
    }

    // Build field mapping grid - Use retailPrice for Unit_Price (MSRP)
    const fieldMappingGrid = document.getElementById('fieldMappingGrid');
    const msrpValue = pricingData?.pricing?.retailPrice ? `$${pricingData.pricing.retailPrice.toFixed(2)}` : '-';
    const fields = [
        { label: 'Product_Code', value: product.vendorPartNumber || '-' },
        { label: 'Product_Name', value: product.description || '-' },
        { label: 'Manufacturer', value: product.vendorName || state.manufacturer },
        { label: 'Ingram_Micro_SKU', value: ingramPn || '-' },
        { label: 'UPC', value: pricingData?.upc || product.upcCode || '-' },
        { label: 'Category', value: product.category || state.category || '-' },
        { label: 'Subcategory', value: product.subCategory || state.subcategory || '-' },
        { label: 'MSRP', value: msrpValue },
        { label: 'Unit_Price', value: msrpValue },  // Use retailPrice for Unit_Price
        { label: 'Currency', value: pricingData?.pricing?.currencyCode || 'USD' },
        { label: 'Total_Availability', value: pricingData?.availability?.totalAvailability ?? '-' },
        { label: 'Is_Available', value: pricingData?.availability?.available ? 'Yes' : 'No' },
        { label: 'Product_Class', value: pricingData?.productClass || '-' },
        { label: 'Is_Discontinued', value: product.discontinued === 'true' ? 'Yes' : 'No' },
        { label: 'Is_New_Product', value: product.newProduct === 'true' ? 'Yes' : 'No' },
        { label: 'Is_Directship', value: product.directShip === 'true' ? 'Yes' : 'No' }
    ];

    fieldMappingGrid.innerHTML = fields.map(f => `
        <div class="field-mapping-item">
            <span class="field-label">${f.label}</span>
            <span class="field-value">${f.value}</span>
        </div>
    `).join('');

    // Build warehouse availability table
    const warehouseSection = document.getElementById('warehouseSection');
    const warehouseBody = document.getElementById('warehouseBody');

    if (pricingData?.availability?.availabilityByWarehouse?.length > 0) {
        warehouseSection.style.display = 'block';
        warehouseBody.innerHTML = pricingData.availability.availabilityByWarehouse.map(wh => `
            <tr>
                <td>${wh.warehouseId}</td>
                <td>${wh.location || '-'}</td>
                <td style="text-align: right;">${wh.quantityAvailable ?? 0}</td>
                <td style="text-align: right;">${wh.quantityBackordered ?? 0}</td>
            </tr>
        `).join('');
    } else {
        warehouseSection.style.display = 'none';
    }

    // Show raw API response
    document.getElementById('rawApiResponse').textContent = JSON.stringify(fullProductData, null, 2);
}

function hideProductDetails() {
    document.getElementById('productDetailsSection').style.display = 'none';
}

// =====================================================
// ACTION HANDLERS
// =====================================================
function addSelectedProducts() {
    const selectedArray = Array.from(state.selectedProducts.values());

    if (selectedArray.length === 0) {
        showStatus('No products selected', 'error');
        return;
    }

    // Format products for Zoho CRM - matches Deluge function params
    const formattedProducts = selectedArray.map(product => {
        // Get pricing data if available
        const pricingData = product.pricingData || state.pricingData?.[product.ingramPartNumber] || {};
        const msrp = pricingData?.pricing?.retailPrice || product.retailPrice || null;

        return {
            // Core fields (used by Deluge function)
            Product_Code: product.vendorPartNumber || '',
            Product_Name: product.description || '',
            Manufacturer: product.vendorName || state.manufacturer,

            // Ingram-specific fields
            Ingram_Micro_SKU: product.ingramPartNumber || '',

            // Pricing - Use retailPrice (MSRP)
            MSRP: msrp,

            // Ingram category fields (separate from TD Synnex Category_Level fields)
            Category: product.category || state.category || '',
            Subcategory: product.subCategory || state.subcategory || '',

            // Additional fields
            UPC: pricingData?.upc || product.upcCode || '',
            Description: product.extraDescription || pricingData?.description || '',

            // Quantity (default)
            Quantity: 1
        };
    });

    console.log('Sending products to parent:', formattedProducts);

    // Close widget and return data to client script via $Client.close()
    // This is the correct pattern for ZDK.Client.openPopup()
    if (typeof $Client !== 'undefined') {
        $Client.close({
            products: formattedProducts,
            distributor: state.currentDistributor
        });
    } else {
        // Standalone mode - just log
        console.log('Standalone mode - would send:', formattedProducts);
        showStatus(`Selected ${formattedProducts.length} products (standalone mode)`, 'info');
    }
}

function cancelSelection() {
    console.log('Cancel clicked');

    // Close widget and return cancelled status via $Client.close()
    if (typeof $Client !== 'undefined') {
        $Client.close({ cancelled: true, products: [] });
    }

    // Clear selections (for standalone mode)
    state.selectedProducts.clear();
    updateSelectedCount();
}

// =====================================================
// UTILITY FUNCTIONS
// =====================================================
function resetFilters() {
    state.manufacturer = '';
    state.category = '';
    state.subcategory = '';
    state.currentPage = 1;

    document.getElementById('manufacturerSearch').value = '';
    document.getElementById('manufacturerSelect').innerHTML =
        '<option value="">Type to search manufacturers...</option>';
    document.getElementById('mfrCount').textContent = '';

    resetCategory();
    resetSubcategory();
    resetProducts();

    document.getElementById('loadProductsBtn').disabled = true;
    document.getElementById('productsSection').style.display = 'none';
}

function resetCategory() {
    document.getElementById('categorySelect').innerHTML =
        '<option value="">-- Select manufacturer first --</option>';
    document.getElementById('categorySelect').disabled = true;
    document.getElementById('catCount').textContent = '';
    state.category = '';
}

function resetSubcategory() {
    document.getElementById('subcategorySelect').innerHTML =
        '<option value="">-- Select category first --</option>';
    document.getElementById('subcategorySelect').disabled = true;
    document.getElementById('subCatCount').textContent = '';
    state.subcategory = '';
}

function resetProducts() {
    document.getElementById('productsBody').innerHTML = '';
    document.getElementById('pagination').innerHTML = '';
    document.getElementById('productCount').textContent = '0 products';
    document.getElementById('productDetailsSection').style.display = 'none';
    state.selectedProducts.clear();
    state.currentProducts = [];
    state.pricingData = {};
    updateSelectedCount();
}

function showStatus(message, type) {
    const el = document.getElementById('filterStatus');
    if (!el) return;

    el.className = `status ${type} show`;
    if (type === 'loading') {
        el.innerHTML = message + ' <span class="loading-spinner"></span>';
    } else {
        el.textContent = message;
    }
    if (!message) el.classList.remove('show');
}
