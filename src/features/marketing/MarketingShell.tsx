import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Menu, X } from 'lucide-react';

const navigation = [
  { label: 'Product', href: '/#product' },
  { label: 'How it works', href: '/#workflow' },
  { label: 'Pricing', href: '/#pricing' },
];

export function MarketingHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);

  function closeMenu() {
    setMenuOpen(false);
  }

  return (
    <header className="marketing-header">
      <div className="marketing-container marketing-header-inner">
        <Link className="folio-brand" to="/" aria-label="Folio home">Folio</Link>
        <nav className="marketing-desktop-nav" aria-label="Main navigation">
          {navigation.map((item) => <a key={item.label} href={item.href}>{item.label}</a>)}
          <Link to="/help">Resources</Link>
        </nav>
        <div className="marketing-header-actions">
          <Link className="marketing-sign-in" to="/sign-in">Sign in</Link>
          <Link className="button primary marketing-cta" to="/sign-up">Start extracting</Link>
        </div>
        <button
          ref={menuButton}
          className="marketing-menu-toggle"
          type="button"
          aria-expanded={menuOpen}
          aria-controls="marketing-mobile-navigation"
          aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? <X size={24} /> : <Menu size={24} />}
        </button>
      </div>
      {menuOpen ? (
        <nav
          id="marketing-mobile-navigation"
          className="marketing-mobile-nav"
          aria-label="Mobile navigation"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              closeMenu();
              menuButton.current?.focus();
            }
          }}
        >
          {navigation.map((item) => <a key={item.label} href={item.href} onClick={closeMenu}>{item.label}</a>)}
          <Link to="/help" onClick={closeMenu}>Resources</Link>
          <Link to="/sign-in" onClick={closeMenu}>Sign in</Link>
          <Link className="button primary marketing-cta" to="/sign-up" onClick={closeMenu}>Start extracting</Link>
        </nav>
      ) : null}
    </header>
  );
}

export function MarketingFooter() {
  return (
    <footer className="marketing-footer marketing-container">
      <div className="marketing-footer-grid">
        <div className="marketing-footer-brand">
          <Link className="folio-brand" to="/" aria-label="Folio home">Folio</Link>
          <p>Documents into useful data.</p>
        </div>
        <nav aria-label="Product links">
          <h3>Product</h3>
          <a href="/#product">Documents</a>
          <Link to="/sign-up">Parsers</Link>
          <a href="/#integrations">Integrations</a>
        </nav>
        <nav aria-label="Resources">
          <h3>Resources</h3>
          <Link to="/help/api">API documentation</Link>
          <Link to="/help">Help</Link>
        </nav>
        <nav aria-label="Legal information">
          <h3>Legal</h3>
          <Link to="/privacy">Privacy</Link>
          <Link to="/terms">Terms</Link>
        </nav>
      </div>
      <div className="marketing-footer-bottom">© 2026 Folio</div>
    </footer>
  );
}
