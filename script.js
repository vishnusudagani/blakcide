const logo = document.getElementById('logo');
const tagline = document.querySelector('.tagline');
const nebula = document.getElementById('nebula');

// Initial Reveal Sequence
window.addEventListener('load', () => {
    // Letters bloom after the ink bleed starts
    setTimeout(() => {
        logo.classList.add('active');
        tagline.classList.add('visible');
    }, 500);
});

// Scroll-Triggered Nebula Morphing
const elements = [
    'radial-gradient(circle at 50% 50%, #e0f2f1, #ffffff)', // Sky
    'radial-gradient(circle at 20% 80%, #e3f2fd, #ffffff)', // Water
    'radial-gradient(circle at 80% 20%, #fff1f0, #ffffff)', // Fire/Sunset
    'radial-gradient(circle at 50% 50%, #f5f5f5, #ffffff)', // Air
    'radial-gradient(circle at 10% 10%, #f1f8e9, #ffffff)'  // Earth
];

window.addEventListener('scroll', () => {
    const scrollPercent = window.scrollY / (document.body.offsetHeight - window.innerHeight);
    const index = Math.min(
        Math.floor(scrollPercent * elements.length),
        elements.length - 1
    );
    
    nebula.style.background = elements[index];
});
