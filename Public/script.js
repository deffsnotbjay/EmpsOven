// Initialize Supabase client for authentication
const SUPABASE_URL = 'https://kkkildlldjhttipywybz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtra2lsZGxsZGpodHRpcHl3eWJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE4NDA5OTcsImV4cCI6MjA4NzQxNjk5N30.1XFow3JeDfxan06H5c925a5xj-LSoNY0HijEvWuZpLg';
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Current user and auth token
let currentUser = null;
let authToken = null;

// Cart management
let cart = JSON.parse(localStorage.getItem('cart')) || [];
// Clean corrupt items from previous bug
cart = cart.filter(item => typeof item === 'object' && item !== null && item.price);
localStorage.setItem('cart', JSON.stringify(cart));

// Function to get auth headers
function getAuthHeaders() {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
    };
}

// Function to generate Gravatar URL
function getGravatarUrl(email, size = 200) {
    const hash = email.trim().toLowerCase();
    // Simple hash function for demo - in production use MD5
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(email.split('@')[0])}&size=${size}&background=FF6B35&color=fff&bold=true`;
}

// Sync local cart to database
async function syncCartToDatabase() {
    if (!currentUser || !authToken) return;

    try {
        const response = await fetch('/api/user/cart/sync', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ cartItems: cart })
        });

        if (response.ok) {
            const data = await response.json();
            cart = data.cart || [];
            localStorage.setItem('cart', JSON.stringify(cart));
            updateCartBadge();
        }
    } catch (error) {
        console.error('Error syncing cart:', error);
    }
}

// Load cart from database
async function loadCartFromDatabase() {
    if (!currentUser || !authToken) return;

    try {
        const response = await fetch('/api/user/cart', {
            method: 'GET',
            headers: getAuthHeaders()
        });

        if (response.ok) {
            const dbCart = await response.json();

            // Merge with local cart (keep highest quantities)
            const mergedCart = [...cart];

            dbCart.forEach(dbItem => {
                const existingItem = mergedCart.find(item => item.id === dbItem.id);
                if (existingItem) {
                    existingItem.quantity = Math.max(existingItem.quantity, dbItem.quantity);
                } else {
                    mergedCart.push(dbItem);
                }
            });

            cart = mergedCart;
            localStorage.setItem('cart', JSON.stringify(cart));
            updateCartBadge();

            // Sync back the merged cart
            if (mergedCart.length > 0) {
                await syncCartToDatabase();
            }
        }
    } catch (error) {
        console.error('Error loading cart:', error);
    }
}

// Update cart badge
function updateCartBadge() {
    const cartBadge = document.getElementById('cartBadge');
    const navCartBadge = document.getElementById('navCartBadge');
    const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);

    if (cartBadge) {
        cartBadge.textContent = totalItems;
        if (totalItems === 0) {
            cartBadge.classList.add('hidden');
        } else {
            cartBadge.classList.remove('hidden');
        }
    }

    if (navCartBadge) {
        navCartBadge.textContent = totalItems;
        if (totalItems === 0) {
            navCartBadge.classList.add('hidden');
        } else {
            navCartBadge.classList.remove('hidden');
        }
    }
}

// Update favorites badge
async function updateFavoritesBadge() {
    const { data: { session } } = await supabaseClient.auth.getSession();
    const favoritesBadge = document.getElementById('favoritesBadge');

    if (!session) {
        favoritesBadge.classList.add('hidden');
        return;
    }

    try {
        const { data, error, count } = await supabaseClient
            .from('favorites')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', session.user.id);

        if (!error && count > 0) {
            favoritesBadge.textContent = count;
            favoritesBadge.classList.remove('hidden');
        } else {
            favoritesBadge.classList.add('hidden');
        }
    } catch (error) {
        console.error('Error loading favorites count:', error);
        favoritesBadge.classList.add('hidden');
    }
}

// Add to cart function
function addToCart(product) {
    const existingItem = cart.find(item => item.id === product.id);
    if (existingItem) {
        existingItem.quantity += 1;
    } else {
        cart.push({ ...product, quantity: 1 });
    }
    localStorage.setItem('cart', JSON.stringify(cart));
    updateCartBadge();

    // Visual feedback
    showAddedToCartAnimation();
}

// Show animation when item is added
function showAddedToCartAnimation() {
    const cartBtn = document.getElementById('cartButton');
    const originalTransform = floatingCart.style.transform;
    cartBtn.style.transform = 'scale(1.3)';
    setTimeout(() => {
        cartBtn.style.transform = 'scale(1)';
    }, 200);
}

// Manage Cart Button Interactions
const cartButton = document.getElementById('cartButton');
if (cartButton) {
    cartButton.addEventListener('click', (e) => {
        if (typeof isDragging === 'undefined' || !isDragging) {
            window.location.href = 'cart.html';
        }
    });
}

const favoritesButton = document.getElementById('favoritesButton');
if (favoritesButton) {
    favoritesButton.addEventListener('click', (e) => {
        if (typeof isDragging === 'undefined' || !isDragging) {
            window.location.href = 'favorites.html';
        }
    });
}

const floatingCart = document.getElementById('floatingCart');
let isDragging = false;
let hasMoved = false;
let currentX;
let currentY;
let initialX;
let initialY;
let xOffset = 0;
let yOffset = 0;

if (floatingCart) {
    floatingCart.addEventListener('mousedown', dragStart);
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', dragEnd);
    floatingCart.addEventListener('touchstart', dragStart);
    document.addEventListener('touchmove', drag);
    document.addEventListener('touchend', dragEnd);
}

function dragStart(e) {
    if (e.type === 'touchstart') {
        initialX = e.touches[0].clientX - xOffset;
        initialY = e.touches[0].clientY - yOffset;
    } else {
        initialX = e.clientX - xOffset;
        initialY = e.clientY - yOffset;
    }

    if (e.target === floatingCart || floatingCart.contains(e.target)) {
        hasMoved = false;
    }
}

function drag(e) {
    if (e.target === floatingCart || floatingCart.contains(e.target)) {
        e.preventDefault();

        if (e.type === 'touchmove') {
            currentX = e.touches[0].clientX - initialX;
            currentY = e.touches[0].clientY - initialY;
        } else {
            currentX = e.clientX - initialX;
            currentY = e.clientY - initialY;
        }

        xOffset = currentX;
        yOffset = currentY;

        if (Math.abs(currentX) > 5 || Math.abs(currentY) > 5) {
            hasMoved = true;
            isDragging = true;
        }

        setTranslate(currentX, currentY, floatingCart);
    }
}

function dragEnd(e) {
    initialX = currentX;
    initialY = currentY;

    setTimeout(() => {
        isDragging = false;
    }, 10);
}

function setTranslate(xPos, yPos, el) {
    el.style.transform = `translate3d(${xPos}px, ${yPos}px, 0)`;
}

// Fetch and display bestsellers
fetch("/api/bestsellers")
    .then(res => res.json())
    .then(data => {
        const menu = document.getElementById("menu");

        if (!menu) return;

        if (data.length === 0) {
            menu.innerHTML = '<p style="text-align: center; grid-column: 1/-1; font-size: 18px; color: #999;">No products available yet. Check back soon!</p>';
            return;
        }

        data.forEach(item => {
            const menuItem = document.createElement('div');
            menuItem.className = 'menu-item bestseller-card';

            let description = item.description;
            if (!description || description.trim() === '') {
                const lowerName = item.name.toLowerCase();
                if (lowerName.includes('cake')) description = "A delicious, freshly baked cake perfect for any celebration.";
                else if (lowerName.includes('croissant')) description = "Flaky, buttery, and baked to golden perfection.";
                else if (lowerName.includes('cooki')) description = "Sweet, chewy, and loaded with flavor in every bite.";
                else if (lowerName.includes('bread')) description = "Soft on the inside with a perfectly crunchy crust.";
                else if (lowerName.includes('pie')) description = "A freshly baked pie with a rich, perfectly sweetened filling.";
                else if (lowerName.includes('tart')) description = "A delicious tart with a crumbly shell and smooth filling.";
                else if (lowerName.includes('puff') || lowerName.includes('chop')) description = "Savory bites filled with rich, seasoned ingredients.";
                else description = `Experience the delightful taste of our freshly made ${item.name.toLowerCase()}. Baked daily to perfection.`;
            }

            const imageHTML = item.image
                ? `<img src="${item.image}" alt="${item.name}" class="bestseller-image">`
                : `<div class="bestseller-image-placeholder"></div>`;

            menuItem.innerHTML = `
    <div class="bestseller-image-wrapper" style="cursor: pointer;" onclick="window.location.href='product-details.html?id=${item.id}'">
        ${imageHTML}
    </div>
    <div class="bestseller-content">
        <h3 class="bestseller-name" style="cursor: pointer;" onclick="window.location.href='product-details.html?id=${item.id}'">${item.name}</h3>
        <p class="bestseller-description">${description}</p>
        <div class="bestseller-price">$${parseFloat(item.price).toFixed(2)}</div>
        <button class="bestseller-add-btn">ADD TO CART</button>
    </div>
`;

            menuItem.querySelector('.bestseller-add-btn').addEventListener('click', () => addToCart(item));
            menu.appendChild(menuItem);
        });
    })
    .catch(error => {
        console.error('Error loading bestsellers:', error);
        const menu = document.getElementById("menu");
        if (menu) menu.innerHTML = '<p style="text-align: center; grid-column: 1/-1; color: red;">Failed to load bestsellers. Please try again later.</p>';
    });

// Category filter functionality
document.querySelectorAll('.category-item').forEach(item => {
    item.addEventListener('click', function () {
        const category = this.querySelector('.category-name').textContent;
        alert(`Filtering by: ${category}`);
        // You can implement actual filtering here
    });
});

// Initialize cart badge on page load
updateCartBadge();
updateFavoritesBadge();

// ==================== AUTHENTICATION ====================
let isLoginMode = true;

// Check if user is already logged in
async function checkSession() {
    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (session) {
            currentUser = session.user;
            authToken = session.access_token;
            await updateUIForUser(currentUser);
            await loadCartFromDatabase(); // Load cart after login
            updateFavoritesBadge(); // Update favorites count when logged in
        }
    } catch (error) {
        console.error('Session check error:', error);
    }
}

// Update UI when user is logged in
async function updateUIForUser(user) {
    const loginBtn = document.getElementById('loginBtn');
    const userMenu = document.getElementById('userMenu');
    const userNameDisplay = document.getElementById('userNameDisplay');
    const userAvatar = document.getElementById('userAvatar');
    const userAvatarPlaceholder = document.getElementById('userAvatarPlaceholder');

    // Hamburger now opens the mobile menu (not a login button), so keep it visible.
    if (loginBtn) loginBtn.style.display = 'flex';
    if (userMenu) userMenu.style.display = 'flex';

    // Display user's name
    const displayName = user.user_metadata?.name || user.user_metadata?.full_name || user.email.split('@')[0];
    if (userNameDisplay) userNameDisplay.textContent = displayName;

    // Set profile picture
    const profilePicUrl = user.user_metadata?.avatar_url || user.user_metadata?.picture || getGravatarUrl(user.email);

    if (userAvatar && userAvatarPlaceholder) {
        if (profilePicUrl) {
            userAvatar.src = profilePicUrl;
            userAvatar.style.display = 'block';
            userAvatarPlaceholder.style.display = 'none';
        } else {
            userAvatar.style.display = 'none';
            userAvatarPlaceholder.style.display = 'block';
        }
    }

    // Update mobile menu account block
    const mobileMenuAuthBtn = document.getElementById('mobileMenuAuthBtn');
    const mobileMenuAccount = document.getElementById('mobileMenuAccount');
    const mobileMenuUserName = document.getElementById('mobileMenuUserName');
    if (mobileMenuAuthBtn) mobileMenuAuthBtn.style.display = 'none';
    if (mobileMenuAccount) mobileMenuAccount.style.display = 'flex';
    if (mobileMenuUserName) mobileMenuUserName.textContent = `Hi, ${displayName}`;
}

// Update UI when user is logged out
function updateUIForLogout() {
    const loginBtn = document.getElementById('loginBtn');
    const userMenu = document.getElementById('userMenu');

    if (loginBtn) loginBtn.style.display = 'flex';
    if (userMenu) userMenu.style.display = 'none';

    // Mobile menu state
    const mobileMenuAuthBtn = document.getElementById('mobileMenuAuthBtn');
    const mobileMenuAccount = document.getElementById('mobileMenuAccount');
    if (mobileMenuAuthBtn) mobileMenuAuthBtn.style.display = 'block';
    if (mobileMenuAccount) mobileMenuAccount.style.display = 'none';

    currentUser = null;
    authToken = null;

    // Clear local cart
    cart = [];
    localStorage.removeItem('cart');
    updateCartBadge();
}

// Show authentication modal
function showAuthModal() {
    document.getElementById('authModal').classList.add('show');
}

// Hide authentication modal
function hideAuthModal() {
    document.getElementById('authModal').classList.remove('show');
    clearAuthMessages();
    clearAuthForms();
}

// Clear authentication messages
function clearAuthMessages() {
    document.getElementById('authError').classList.remove('show');
    document.getElementById('authSuccess').classList.remove('show');
}

// Clear authentication forms
function clearAuthForms() {
    document.getElementById('loginForm').reset();
    document.getElementById('signupForm').reset();
}

// Show error message
function showError(message) {
    const errorEl = document.getElementById('authError');
    errorEl.textContent = message;
    errorEl.classList.add('show');
    setTimeout(() => errorEl.classList.remove('show'), 5000);
}

// Show success message
function showSuccess(message) {
    const successEl = document.getElementById('authSuccess');
    successEl.textContent = message;
    successEl.classList.add('show');
    setTimeout(() => successEl.classList.remove('show'), 3000);
}

// Toggle between login and signup
function toggleAuthMode() {
    isLoginMode = !isLoginMode;
    const loginForm = document.getElementById('loginForm');
    const signupForm = document.getElementById('signupForm');
    const authTitle = document.getElementById('authTitle');
    const authSubtitle = document.getElementById('authSubtitle');
    const switchText = document.getElementById('switchText');
    const switchLink = document.getElementById('switchLink');

    clearAuthMessages();

    if (isLoginMode) {
        loginForm.style.display = 'flex';
        signupForm.style.display = 'none';
        authTitle.textContent = 'Welcome Back!';
        authSubtitle.textContent = 'Sign in to your account';
        switchText.textContent = "Don't have an account? ";
        switchLink.textContent = 'Sign up';
    } else {
        loginForm.style.display = 'none';
        signupForm.style.display = 'flex';
        authTitle.textContent = 'Create Account';
        authSubtitle.textContent = 'Sign up to save your orders';
        switchText.textContent = 'Already have an account? ';
        switchLink.textContent = 'Sign in';
    }
}

// Handle login
async function handleLogin(e) {
    e.preventDefault();
    clearAuthMessages();

    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    const submitBtn = document.getElementById('loginSubmitBtn');

    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in...';

    try {
        const { data, error } = await supabaseClient.auth.signInWithPassword({
            email,
            password
        });

        if (error) throw error;

        currentUser = data.user;
        authToken = data.session.access_token;

        await updateUIForUser(currentUser);
        await syncCartToDatabase(); // Sync cart after login

        showSuccess('Login successful!');

        setTimeout(() => {
            hideAuthModal();
        }, 1500);

    } catch (error) {
        showError(error.message || 'Login failed. Please try again.');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Sign In';
    }
}

// Handle signup
async function handleSignup(e) {
    e.preventDefault();
    clearAuthMessages();

    const name = document.getElementById('signupName').value;
    const email = document.getElementById('signupEmail').value;
    const password = document.getElementById('signupPassword').value;
    const submitBtn = document.getElementById('signupSubmitBtn');

    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating account...';

    try {
        const { data, error } = await supabaseClient.auth.signUp({
            email,
            password,
            options: {
                data: {
                    name: name,
                    full_name: name
                },
                emailRedirectTo: window.location.origin + '/index.html'
            }
        });

        if (error) throw error;

        // Check if email confirmation is required
        if (data.user && data.user.identities && data.user.identities.length === 0) {
            showError('This email is already registered. Please sign in instead.');
            return;
        }

        if (data.session) {
            // Instant login (email confirmation disabled)
            currentUser = data.user;
            authToken = data.session.access_token;
            await updateUIForUser(currentUser);
            showSuccess('Account created successfully!');

            setTimeout(() => {
                hideAuthModal();
            }, 1500);
        } else {
            // Email confirmation required
            showSuccess('Account created! Please check your email to verify.');

            setTimeout(() => {
                toggleAuthMode();
                document.getElementById('loginEmail').value = email;
            }, 3000);
        }

    } catch (error) {
        showError(error.message || 'Signup failed. Please try again.');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create Account';
    }
}

// Handle logout
async function handleLogout() {
    if (confirm('Are you sure you want to logout?')) {
        try {
            await supabaseClient.auth.signOut();
            updateUIForLogout();
            showSuccess('Logged out successfully!');

            // Redirect to home if on restricted pages
            if (window.location.pathname.includes('orders.html')) {
                setTimeout(() => {
                    window.location.href = 'index.html';
                }, 1000);
            }
        } catch (error) {
            alert('Error logging out: ' + error.message);
        }
    }
}

// Handle Google Sign-In
async function handleGoogleSignIn() {
    const googleBtn = document.getElementById('googleSignInBtn');
    googleBtn.disabled = true;
    googleBtn.textContent = 'Redirecting to Google...';

    try {
        const { data, error } = await supabaseClient.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo: window.location.origin + '/index.html',
                queryParams: {
                    access_type: 'offline',
                    prompt: 'consent'
                }
            }
        });

        if (error) throw error;

    } catch (error) {
        console.error('Google sign-in error:', error);
        showError(error.message || 'Google sign-in failed. Please try again.');
        googleBtn.disabled = false;
        googleBtn.innerHTML = `
                    <svg class="google-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                    </svg>
                    Continue with Google
                `;
    }
}

// Event Listeners for Authentication - Wrapped in DOMContentLoaded
document.addEventListener('DOMContentLoaded', function () {
    // Make sure elements exist before adding listeners
    const loginBtn = document.getElementById('loginBtn');
    const closeAuthModal = document.getElementById('closeAuthModal');
    const authModal = document.getElementById('authModal');
    const switchLink = document.getElementById('switchLink');
    const loginForm = document.getElementById('loginForm');
    const signupForm = document.getElementById('signupForm');
    const userProfileBtn = document.getElementById('userProfileBtn');
    const userDropdown = document.getElementById('userDropdown');
    const logoutBtn = document.getElementById('logoutBtn');
    const googleSignInBtn = document.getElementById('googleSignInBtn');

    // Mobile menu elements
    const mobileMenu = document.getElementById('mobileMenu');
    const mobileMenuBackdrop = document.getElementById('mobileMenuBackdrop');
    const mobileMenuClose = document.getElementById('mobileMenuClose');
    const mobileMenuAuthBtn = document.getElementById('mobileMenuAuthBtn');
    const mobileMenuLogoutBtn = document.getElementById('mobileMenuLogoutBtn');

    function openMobileMenu() {
        if (!mobileMenu) return;
        mobileMenu.classList.add('open');
        mobileMenu.setAttribute('aria-hidden', 'false');
        document.body.classList.add('mobile-menu-open');
    }

    function closeMobileMenu() {
        if (!mobileMenu) return;
        mobileMenu.classList.remove('open');
        mobileMenu.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('mobile-menu-open');
    }

    function toggleMobileMenu() {
        if (!mobileMenu) return;
        if (mobileMenu.classList.contains('open')) closeMobileMenu();
        else openMobileMenu();
    }

    if (loginBtn) {
        loginBtn.addEventListener('click', (e) => {
            e.preventDefault();
            toggleMobileMenu();
        });
    }

    if (mobileMenuBackdrop) {
        mobileMenuBackdrop.addEventListener('click', closeMobileMenu);
    }

    if (mobileMenuClose) {
        mobileMenuClose.addEventListener('click', closeMobileMenu);
    }

    if (mobileMenuAuthBtn) {
        mobileMenuAuthBtn.addEventListener('click', () => {
            closeMobileMenu();
            showAuthModal();
        });
    }

    // Mobile menu account links
    if (mobileMenu) {
        mobileMenu.querySelectorAll('[data-href]').forEach(btn => {
            btn.addEventListener('click', () => {
                const href = btn.getAttribute('data-href');
                if (href) window.location.href = href;
            });
        });

        mobileMenu.querySelectorAll('a.mobile-menu-link').forEach(a => {
            a.addEventListener('click', () => {
                closeMobileMenu();
            });
        });
    }

    if (mobileMenuLogoutBtn) {
        mobileMenuLogoutBtn.addEventListener('click', async () => {
            closeMobileMenu();
            await handleLogout();
        });
    }

    // Close on Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeMobileMenu();
        }
    });

    if (closeAuthModal) {
        closeAuthModal.addEventListener('click', hideAuthModal);
    }

    if (authModal) {
        authModal.addEventListener('click', (e) => {
            if (e.target.id === 'authModal') {
                hideAuthModal();
            }
        });
    }

    if (switchLink) {
        switchLink.addEventListener('click', toggleAuthMode);
    }

    if (loginForm) {
        loginForm.addEventListener('submit', handleLogin);
    }

    if (signupForm) {
        signupForm.addEventListener('submit', handleSignup);
    }

    // Profile dropdown toggle
    if (userProfileBtn && userDropdown) {
        userProfileBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            userDropdown.classList.toggle('show');
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!userProfileBtn.contains(e.target) && !userDropdown.contains(e.target)) {
                userDropdown.classList.remove('show');
            }
        });
    }

    if (logoutBtn) {
        logoutBtn.addEventListener('click', handleLogout);
    }

    if (googleSignInBtn) {
        googleSignInBtn.addEventListener('click', handleGoogleSignIn);
    }

    // Listen for auth state changes
    supabaseClient.auth.onAuthStateChange(async (event, session) => {
        console.log('Auth state changed:', event);

        if (event === 'SIGNED_IN' && session) {
            currentUser = session.user;
            authToken = session.access_token;
            await updateUIForUser(currentUser);
            await syncCartToDatabase();
        } else if (event === 'SIGNED_OUT') {
            updateUIForLogout();
        } else if (event === 'TOKEN_REFRESHED' && session) {
            authToken = session.access_token;
        }
    });

    // Check session on page load
    checkSession();
});






