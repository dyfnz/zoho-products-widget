/**
 * Distributor Product Lookup Widget
 * For Zoho CRM Quotes module integration
 * Updated: December 2025 - Flexible filter system
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
    // Filters - manufacturer is required, others are optional
    manufacturer: '',
    category: '',
    subcategory: '',
    skuType: '',  // SKU Type: IM::physical, IM::digital, IM::subscription (API param: type)
    skuKeyword: '',
    // Filter loading state (prevent duplicate loads)
    loadingFilters: {
        category: false,
        subcategory: false
    },
    // Filter loaded state (don't reload if already loaded with same params)
    filterParams: {
        category: '',
        subcategory: ''
    },
    // Pagination and products
    currentPage: 1,
    selectedProducts: new Map(), // Map of partNumber -> product
    isAuthenticated: false,
    pendingResponseId: null, // For NotifyAndWait response
    parentContext: null,
    currentProducts: [], // Products currently displayed
    pricingData: {} // Cached pricing data by ingramPartNumber
};

let searchTimeout = null;
let skuSearchTimeout = null;

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

    // SKU search with debounce
    const skuSearch = document.getElementById('skuSearch');
    if (skuSearch) {
        skuSearch.addEventListener('input', debounceSkuSearch);
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
// MANUFACTURER SELECTION
// =====================================================
async function onManufacturerSelect() {
    const select = document.getElementById('manufacturerSelect');
    state.manufacturer = select.value;

    // Reset all optional filters
    resetOptionalFilters();
    resetProducts();

    if (!state.manufacturer) {
        // Hide optional filter rows
        document.getElementById('optionalFiltersRow').style.display = 'none';
        document.getElementById('skuActionsRow').style.display = 'none';
        return;
    }

    // Show optional filter rows
    document.getElementById('optionalFiltersRow').style.display = 'flex';
    document.getElementById('skuActionsRow').style.display = 'flex';

    showStatus(`Manufacturer: ${state.manufacturer}. Use filters below or click Load Products.`, 'success');
}

// =====================================================
// FLEXIBLE FILTER LOADING (on-demand)
// =====================================================
async function loadFilterOptions(filterType) {
    // Build current filter params string for cache check
    const currentParams = `${state.manufacturer}|${state.category}|${state.subcategory}|${state.skuType}`;

    // Skip if already loading or already loaded with same params
    if (state.loadingFilters[filterType]) return;
    if (state.filterParams[filterType] === currentParams) return;

    state.loadingFilters[filterType] = true;

    let url = `${PROXY_BASE}?vendor=${encodeURIComponent(state.manufacturer)}`;
    let selectEl, countEl, dataKey;

    switch (filterType) {
        case 'category':
            url += `&action=categories`;
            if (state.subcategory) url += `&subCategory=${encodeURIComponent(state.subcategory)}`;
            if (state.skuType) url += `&type=${encodeURIComponent(state.skuType)}`;
            selectEl = document.getElementById('categorySelect');
            countEl = document.getElementById('catCount');
            dataKey = 'categories';
            break;

        case 'subcategory':
            url += `&action=subcategories`;
            if (state.category) url += `&category=${encodeURIComponent(state.category)}`;
            if (state.skuType) url += `&type=${encodeURIComponent(state.skuType)}`;
            selectEl = document.getElementById('subcategorySelect');
            countEl = document.getElementById('subCatCount');
            dataKey = 'subcategories';
            break;

        default:
            // SKU Type has fixed options (no API call needed)
            state.loadingFilters[filterType] = false;
            return;
    }

    // Show loading state
    const currentValue = selectEl.value;
    selectEl.innerHTML = '<option value="">Loading...</option>';

    try {
        const response = await fetch(url);
        const data = await response.json();

        selectEl.innerHTML = '<option value="">-- Any --</option>';

        const items = data[dataKey] || [];
        if (items.length > 0) {
            items.forEach(item => {
                const option = document.createElement('option');
                option.value = item;
                option.textContent = item;
                selectEl.appendChild(option);
            });
            countEl.textContent = `(${items.length})`;

            // Restore previous selection if still valid
            if (currentValue && items.includes(currentValue)) {
                selectEl.value = currentValue;
            }
        } else {
            countEl.textContent = '(0)';
        }

        // Cache the params used
        state.filterParams[filterType] = currentParams;

    } catch (error) {
        console.error(`Error loading ${filterType}:`, error);
        selectEl.innerHTML = '<option value="">-- Error --</option>';
    }

    state.loadingFilters[filterType] = false;
}

// Format SKU type for display (type field from Ingram - IM::Physical, etc.)
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
        case 'IM::any':
        case 'IM::Any':
        case 'Any':
            return 'Any';
        default:
            return type || '-';
    }
}

// Handle filter selection change
function onFilterChange(filterType) {
    const selectEl = document.getElementById(
        filterType === 'category' ? 'categorySelect' :
        filterType === 'subcategory' ? 'subcategorySelect' :
        'skuTypeSelect'
    );

    // Update state
    state[filterType] = selectEl.value;

    // Invalidate other filter caches (they may need to reload with new params)
    if (filterType !== 'category') state.filterParams.category = '';
    if (filterType !== 'subcategory') state.filterParams.subcategory = '';

    // Reset products when filters change
    resetProducts();
}

// =====================================================
// SKU SEARCH (Type-ahead with all filters)
// =====================================================
function debounceSkuSearch() {
    clearTimeout(skuSearchTimeout);
    skuSearchTimeout = setTimeout(searchSkus, 400);
}

async function searchSkus() {
    const searchTerm = document.getElementById('skuSearch').value.trim();
    const selectEl = document.getElementById('skuSelect');

    state.skuKeyword = searchTerm;

    if (searchTerm.length < 2) {
        selectEl.style.display = 'none';
        selectEl.innerHTML = '<option value="">Type 2+ chars to search...</option>';
        document.getElementById('skuCount').textContent = '';
        return;
    }

    if (!state.manufacturer) {
        showStatus('Select a manufacturer first', 'error');
        return;
    }

    showStatus(`Searching SKUs matching "${searchTerm}"...`, 'loading');

    try {
        // Build URL with all active filters
        let url = `${PROXY_BASE}?action=skuSearch&vendor=${encodeURIComponent(state.manufacturer)}&keyword=${encodeURIComponent(searchTerm)}`;
        if (state.category) url += `&category=${encodeURIComponent(state.category)}`;
        if (state.subcategory) url += `&subCategory=${encodeURIComponent(state.subcategory)}`;
        if (state.skuType) url += `&type=${encodeURIComponent(state.skuType)}`;

        const response = await fetch(url);
        const data = await response.json();

        selectEl.innerHTML = '<option value="">-- Select a product --</option>';

        if (data.products && data.products.length > 0) {
            data.products.forEach(product => {
                const option = document.createElement('option');
                option.value = JSON.stringify(product);
                const desc = (product.description || '').substring(0, 30);
                option.textContent = `${product.vendorPartNumber || product.ingramPartNumber} - ${desc}`;
                selectEl.appendChild(option);
            });

            selectEl.style.display = 'block';
            document.getElementById('skuCount').textContent = `(${data.products.length}${data.recordsFound > 25 ? '+' : ''})`;
            showStatus(`Found ${data.recordsFound} products matching "${searchTerm}"`, 'success');
        } else {
            selectEl.innerHTML = '<option value="">No products found</option>';
            selectEl.style.display = 'block';
            document.getElementById('skuCount').textContent = '(0)';
            showStatus('No products found', 'info');
        }
    } catch (error) {
        showStatus('Error searching SKUs: ' + error.message, 'error');
    }
}

// Handle SKU selection from dropdown
function onSkuSelect() {
    const selectEl = document.getElementById('skuSelect');
    const value = selectEl.value;

    if (!value) return;

    try {
        const product = JSON.parse(value);
        // Add to selected products and show details
        const partNumber = product.ingramPartNumber || product.vendorPartNumber;
        state.selectedProducts.set(partNumber, product);
        updateSelectedCount();

        // Show product in results table
        state.currentProducts = [product];
        displayProducts([product], { page: 1, pageSize: 1, totalPages: 1, totalRecords: 1 });
        document.getElementById('productsSection').style.display = 'block';

        showStatus(`Selected: ${product.vendorPartNumber}`, 'success');
    } catch (e) {
        console.error('Error parsing product:', e);
    }
}

// =====================================================
// PRODUCTS LOADING (with all flexible filters + pricing in one call)
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
        // Use productsWithPricing for faster MSRP display (single call instead of two)
        let url = `${PROXY_BASE}?action=productsWithPricing&vendor=${encodeURIComponent(state.manufacturer)}&page=${page}`;
        if (state.category) url += `&category=${encodeURIComponent(state.category)}`;
        if (state.subcategory) url += `&subCategory=${encodeURIComponent(state.subcategory)}`;
        if (state.skuType) url += `&type=${encodeURIComponent(state.skuType)}`;
        if (state.skuKeyword && state.skuKeyword.length >= 2) {
            url += `&keyword=${encodeURIComponent(state.skuKeyword)}`;
        }

        const response = await fetch(url);
        const data = await response.json();

        if (data.products && data.products.length > 0) {
            // Products already include pricingData from the combined endpoint
            displayProductsWithPricing(data.products, data.pagination);
            showStatus('', ''); // Clear status
        } else {
            document.getElementById('productsBody').innerHTML =
                '<tr><td colspan="7" class="no-results">No products found</td></tr>';
            document.getElementById('pagination').innerHTML = '';
            document.getElementById('productCount').textContent = '0 products';
            showStatus('No products found with current filters', 'info');
        }
    } catch (error) {
        showStatus('Error loading products: ' + error.message, 'error');
    }
}

// Display products with pre-fetched pricing (faster than separate call)
function displayProductsWithPricing(products, pagination) {
    const tbody = document.getElementById('productsBody');
    tbody.innerHTML = '';

    // Store products for later use
    state.currentProducts = products;
    state.pricingData = {};

    products.forEach((product, index) => {
        const partNumber = product.ingramPartNumber || product.vendorPartNumber;
        const isSelected = state.selectedProducts.has(partNumber);

        // Extract pricing from pre-fetched data
        const pricingData = product.pricingData;
        const msrp = pricingData?.pricing?.retailPrice;
        const msrpDisplay = msrp ? `<span class="price-available">$${msrp.toFixed(2)}</span>` : '<span class="price-unavailable">-</span>';

        // Cache pricing data
        if (pricingData && product.ingramPartNumber) {
            state.pricingData[product.ingramPartNumber] = pricingData;
        }

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
            <td class="price">${msrpDisplay}</td>
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

    // No need to call fetchBatchPricing - pricing already included!
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
    let productDetails = null;
    let fullProductData = product;

    // Fetch pricing and product details in parallel
    if (ingramPn) {
        const fetchPromises = [];

        // Fetch pricing if not cached
        if (!pricingData) {
            fetchPromises.push(
                fetch(`${PROXY_BASE}?action=pricing`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        partNumbers: [ingramPn],
                        sandbox: false
                    })
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

        // Always fetch product details to get indicators
        fetchPromises.push(
            fetch(`${PROXY_BASE}?action=productDetails&ingramPartNumber=${encodeURIComponent(ingramPn)}`)
                .then(res => res.json())
                .then(data => {
                    if (data && !data.error) {
                        productDetails = data;
                        console.log('[Details] Got product details with indicators:', data.indicators ? 'yes' : 'no');
                    }
                })
                .catch(err => console.error('[Details] Error fetching product details:', err))
        );

        // Wait for all fetches to complete
        await Promise.all(fetchPromises);
    }

    // Merge all data
    fullProductData = { ...product, pricingData, productDetails };

    // Determine authorization status (from catalog search or pricing data)
    const isAuthorized = product.authorizedToPurchase === 'true' ||
                         product.authorizedToPurchase === true ||
                         pricingData?.productAuthorized === true;
    const authorizedText = isAuthorized ? 'Yes' : 'No';

    // Set title and subtitle (HEADER - UNCHANGED)
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

    // =========================================================================
    // EXTENDED DETAILS - Grouped Layout
    // =========================================================================

    // Helper to render a grid
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

    // Helper for Yes/No/- display (handles boolean, string "True"/"False", "true"/"false")
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

    // Format currency
    const formatCurrency = (val) => {
        if (val === null || val === undefined) return '-';
        return `$${Number(val).toFixed(2)}`;
    };

    // ----- GROUP 1: Product Information -----
    const productInfoFields = [
        { label: 'Product Name', value: product.description || '-' },
        { label: 'Category', value: product.category || state.category || '-' },
        { label: 'Subcategory', value: product.subCategory || state.subcategory || '-' },
        { label: 'Product Type', value: product.productType || '-' },
        { label: 'SKU Type', value: formatSKUType(product.type) },
        { label: 'Product Class', value: pricingData?.productClass || product.productClass || '-' },
        { label: 'Replacement SKU', value: product.replacementSku || '-' }
    ];
    renderGrid('productInfoGrid', productInfoFields);

    // ----- GROUP 2: Pricing -----
    const msrpValue = formatCurrency(pricingData?.pricing?.retailPrice);
    const customerPriceValue = formatCurrency(pricingData?.pricing?.customerPrice);

    // Check for subscription pricing (for cloud/subscription products)
    let subscriptionPriceValue = '-';
    if (pricingData?.subscriptionPrice && Array.isArray(pricingData.subscriptionPrice) && pricingData.subscriptionPrice.length > 0) {
        const subPrice = pricingData.subscriptionPrice[0];
        if (subPrice?.options?.[0]?.resourcePricing?.[0]?.msrp) {
            subscriptionPriceValue = formatCurrency(subPrice.options[0].resourcePricing[0].msrp);
        }
    }

    const pricingFields = [
        { label: 'MSRP', value: msrpValue },
        { label: 'Customer Price', value: customerPriceValue },
        { label: 'Subscription Price', value: subscriptionPriceValue }
    ];
    renderGrid('pricingGrid', pricingFields);

    // ----- GROUP 3: Discounts (Table - Option B: Show ALL) -----
    const discountsGroup = document.getElementById('discountsGroup');
    const discountsBody = document.getElementById('discountsBody');

    // Extract all discounts from the pricing response
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
                <td style="text-align: right;">${formatCurrency(d.specialPricingDiscount)}</td>
                <td style="text-align: right;">${d.specialPricingAvailableQuantity ?? '-'}</td>
                <td>${d.specialPricingEffectiveDate || '-'}</td>
                <td>${d.specialPricingExpirationDate || '-'}</td>
            </tr>
        `).join('');
    } else {
        discountsGroup.style.display = 'none';
    }

    // ----- GROUP 4: Availability -----
    const availabilityFields = [
        { label: 'Available Qty', value: pricingData?.availability?.totalAvailability ?? '-' },
        { label: 'In Stock', value: yesNo(pricingData?.availability?.available) }
    ];
    renderGrid('availabilityGrid', availabilityFields);

    // ----- GROUP 5: Product Flags -----
    // Indicators come from Product Details endpoint (fetched above)
    const indicators = productDetails?.indicators || {};

    const flagsFields = [
        { label: 'Digital Product', value: yesNo(indicators.isDigitalType || product.type === 'IM::Digital' || product.type === 'IM::digital' || product.type === 'Digital') },
        { label: 'License Product', value: yesNo(indicators.isLicenseProduct) },
        { label: 'Service SKU', value: yesNo(indicators.isServiceSku) },
        { label: 'Has Bundle', value: yesNo(indicators.hasBundle || pricingData?.bundlePartIndicator) },
        { label: 'Direct Ship', value: yesNo(product.directShip || indicators.isDirectship) },
        { label: 'Discontinued', value: yesNo(product.discontinued || indicators.isDiscontinuedProduct) },
        { label: 'New Product', value: yesNo(product.newProduct || indicators.isNewProduct) }
    ];
    renderGrid('flagsGrid', flagsFields);

    // =========================================================================
    // WAREHOUSE AVAILABILITY (Unchanged)
    // =========================================================================
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

            // Sync tracking - identifies which distributor created/updated this product
            Last_Sync_Source: DISTRIBUTORS[state.currentDistributor]?.name || 'Ingram Micro',

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
    state.currentPage = 1;

    document.getElementById('manufacturerSearch').value = '';
    document.getElementById('manufacturerSelect').innerHTML =
        '<option value="">Type to search manufacturers...</option>';
    document.getElementById('mfrCount').textContent = '';

    // Hide optional filter rows
    document.getElementById('optionalFiltersRow').style.display = 'none';
    document.getElementById('skuActionsRow').style.display = 'none';

    resetOptionalFilters();
    resetProducts();

    document.getElementById('productsSection').style.display = 'none';
    showStatus('Select a manufacturer to begin', 'info');
}

function resetOptionalFilters() {
    // Reset state
    state.category = '';
    state.subcategory = '';
    state.skuType = '';
    state.skuKeyword = '';

    // Reset filter param cache
    state.filterParams.category = '';
    state.filterParams.subcategory = '';

    // Reset Category dropdown
    const catSelect = document.getElementById('categorySelect');
    if (catSelect) {
        catSelect.innerHTML = '<option value="">-- Any --</option>';
        document.getElementById('catCount').textContent = '';
    }

    // Reset Subcategory dropdown
    const subSelect = document.getElementById('subcategorySelect');
    if (subSelect) {
        subSelect.innerHTML = '<option value="">-- Any --</option>';
        document.getElementById('subCatCount').textContent = '';
    }

    // Reset SKU Type dropdown (fixed options, just reset selection)
    const skuTypeSelect = document.getElementById('skuTypeSelect');
    if (skuTypeSelect) {
        skuTypeSelect.value = '';
    }

    // Reset SKU search
    const skuSearch = document.getElementById('skuSearch');
    if (skuSearch) {
        skuSearch.value = '';
    }
    const skuSelect = document.getElementById('skuSelect');
    if (skuSelect) {
        skuSelect.innerHTML = '<option value="">Type to search SKUs...</option>';
        skuSelect.style.display = 'none';
        document.getElementById('skuCount').textContent = '';
    }
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
