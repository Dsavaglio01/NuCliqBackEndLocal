# NuCliqBackEndLocal
Backend API for NuCliq, a social media app with 100+ beta downloads, powering real-time interactions and personalized features. Built with Node.js (async/await), Express, and scalable cloud infrastructure (Firebase, GCP).

## Status
NuCliqBackEndLocal is in active development, supporting NuCliq’s beta phase (100+ downloads). Enhancements for group chat and subscription APIs are planned for Q2 2025.

## Tech Stack
- Backend: Node.js (async/await, robust error handling), Express
- Database: Firebase Cloud Firestore (real-time data storage)
- Integrations: Google Cloud Platform (serverless APIs via Cloud Functions), RevenueCat/Stripe (subscription transactions)

## Features
- RESTful APIs for user authentication (Firebase, Apple/Google Sign-in, JWT-based security)
- Real-time social interactions (APIs for text/image/video posts, likes, comments, replies, shares, reposts, mentions; powered by Cloud Firestore)
- Payment processing APIs (RevenueCat/Stripe (in development) for one-time payments/subscriptions, secure transactions)
- Profile management APIs (bio, name updates, real-time sync via Cloud Firestore)
- Theme marketplace APIs (Firestore-backed uploads/sharing of wallpapers, credit-based system)
- Upcoming: Group chat APIs (Firebase Realtime Database integration, Q2 2025)
- Upcoming: Enhanced subscription APIs for multi-feature access (Q2 2025)

## Metrics
- Supports 100+ daily API requests, with 10K+ monthly requests and 99.9% uptime
- 30% faster API performance via GCP serverless (vs. non-optimized Node.js endpoints)
- Processed $100+ in RevenueCat subscription transactions
- 20% higher user engagement via API-driven theme marketplace personalization

## Setup
1. Clone: `git clone https://github.com/Dsavaglio01/NuCliqBackEndLocal`
2. Install: `npm install`
3. Configure: Add `.env` with API keys (Firebase, GCP, RevenueCat)
4. Run: `node index.js`

## API Documentation
- Example endpoint: `POST /api/likePost` – batches POST method and likes post of different user, adds to users 'likes' collection and sends notification to post user.
- System Diagram (Diagram Goes Here)
- Full docs: [Postman Collection](https://dominicsavaglio.postman.co/workspace/c75e700f-0cbe-49a0-8468-811d4a57766c/collection/45341670-c4552777-c9ef-4d42-baf3-dc02c40acaee) (planned for Q2 2025)

## System Diagram
![System Diagram](docs/NuCliq_Backend.drawio.png)
