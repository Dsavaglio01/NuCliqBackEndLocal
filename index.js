const express = require('express')
const bodyParser = require('body-parser')
const axios = require('axios');
const FormData = require('form-data');
const app = express();
require('dotenv').config()
const { MODERATION_API_USER, MODERATION_API_SECRET, STRIPE_TEST_KEY, EXPO_TOKEN, SERVICE_ACCOUNT_PATH,
  DATABASE_URL, STORAGE_BUCKET, CLIENT_ID, CLIENT_SECRET, IMAGE_MODERATION_URL, 
} = process.env;
const stripe = require('stripe')(STRIPE_TEST_KEY);
const {Expo} = require('expo-server-sdk')
let expo = new Expo({ accessToken: EXPO_TOKEN });
const cors = require('cors');
var langdetect = require('langdetect');
var sightengine = require('sightengine')(MODERATION_API_USER, MODERATION_API_SECRET);
const { initializeApp, cert } = require('firebase-admin/app');
const admin = require('firebase-admin')
const {FieldValue, getFirestore} = require('firebase-admin/firestore')
const serviceAccount = require(SERVICE_ACCOUNT_PATH)
const firebaseApp = initializeApp({
  credential: cert(serviceAccount),
  databaseURL: DATABASE_URL,
  storageBucket: STORAGE_BUCKET
});
const db = getFirestore('qadb')
let accessToken = null;
let tokenExpirationTime = null;
const getAccessToken = async () => {
  // If we have a valid cached token, return it
  if (accessToken && tokenExpirationTime > Date.now()) {
    return accessToken;
  }

  const authString = `${CLIENT_ID}:${CLIENT_SECRET}`;
  const authBase64 = Buffer.from(authString).toString('base64');

  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authBase64}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    const data = await response.json();
    if (data.error) {
      throw new Error(data.error_description);
    }

    accessToken = data.access_token;
    tokenExpirationTime = Date.now() + (data.expires_in * 1000); // Convert seconds to milliseconds

    return accessToken;
  } catch (error) {
    console.error('Error getting access token:', error);
    throw error; // Rethrow the error for proper handling
  }
};



app.use(express.json());
app.use(cors())
/* app.use(cors({
    origin: 'http://localhost:3000', // Allow requests from this origin
    methods: ['GET', 'POST', 'PUT', 'DELETE'], // Allow these methods
    allowedHeaders: ['Content-Type', 'Authorization'] // Allow these headers
})); */
async function moderateText(text, textModerationURL) {
    const formData = new FormData();
    formData.append('text', text);
    formData.append('lang', 'en');
    formData.append('mode', 'standard');
    formData.append('api_user', MODERATION_API_USER);
    formData.append('api_secret', MODERATION_API_SECRET);

    try {
        const response = await axios.post(textModerationURL, formData);
        if (response.data?.link?.matches.length > 0) return { link: true };
        if (response.data?.profanity?.matches.some(obj => obj.intensity === 'high')) return { profanity: true };
        return { approved: true };
    } catch (error) {
        console.error("Moderation API error:", error.message);
        return { error: "Text moderation failed." };
    }
}
async function addReplyUsername(data, collectionType) {
    const { focusedPost, tempReplyId, newReply, userId, textModerationURL } = data.data;
    const formData = new FormData();
    formData.append('text', newReply.reply);
    formData.append('lang', 'en');
    formData.append('mode', 'standard');
    formData.append('api_user', MODERATION_API_USER);
    formData.append('api_secret', MODERATION_API_SECRET);
    console.log(newReply)
    const moderationResult = await moderateText(newReply.reply, textModerationURL);
    if (moderationResult.link || moderationResult.profanity) return moderationResult;
    if (moderationResult.error) return moderationResult;
    try {
        const batch = db.batch();
        const commentRef = db.collection(collectionType).doc(focusedPost.id).collection('comments').doc(tempReplyId);
        const postRef = db.collection(collectionType).doc(focusedPost.id);
        const profileRef = db.collection('profiles').doc(userId).collection('comments').doc(tempReplyId);

        batch.update(commentRef, { replies: FieldValue.arrayUnion(newReply) });
        batch.update(postRef, { comments: FieldValue.increment(1) });
        batch.set(profileRef, { replies: FieldValue.arrayUnion(newReply) });

        await batch.commit();
        return { done: true };
    } catch (error) {
        console.error(error);
        return { error: 'Failed to add reply to comment.' };
    }
}
async function addReply(data, collectionType) {
    const { focusedPost, tempReplyId, newReply, userId, reply, username, commentSnap, textModerationURL } = data.data;
    const formData = new FormData();
    formData.append('text', newReply.reply);
    formData.append('lang', 'en');
    formData.append('mode', 'standard');
    formData.append('api_user', MODERATION_API_USER);
    formData.append('api_secret', MODERATION_API_SECRET);
    const moderationResult = await moderateText(newReply.reply, textModerationURL);
    if (moderationResult.link || moderationResult.profanity) return moderationResult;
    if (moderationResult.error) return moderationResult;
    try {
        const batch = db.batch();
        const commentRef = db.collection(collectionType).doc(focusedPost.id).collection('comments').doc(tempReplyId)
        const postRef = db.collection(collectionType).doc(focusedPost.id)
        const profileRef = db.collection('profiles').doc(commentSnap.user).collection('notifications').doc()
        const profileCheckRef = db.collection('profiles').doc(commentSnap.user).collection('checkNotifications').doc()
        batch.update(commentRef, { replies: FieldValue.arrayUnion(newReply) });
        batch.update(postRef, { comments: FieldValue.increment(1) });
        batch.set(profileRef, {
            like: false,
            reply: true,
            friend: false,
            item: reply,
            request: false,
            acceptRequest: false,
            theme: false,
            report: false,
            requestUser: userId,
            postId: focusedPost.id,
            requestNotificationToken: focusedPost.notificationToken,
            likedBy: username,
            timestamp: FieldValue.serverTimestamp()
        })
        batch.set(profileCheckRef, {
            userId: userId
        })
        await batch.commit();
        return { done: true };
    } catch (error) {
        console.error(error);
        return { error: 'Failed to add reply to comment.' };
    }
}
async function addComment(data, collectionType) {
    const { focusedPost, newComment, blockedUsers, notificationToken, user, username, textModerationURL, pfp } = data.data;
    const formData = new FormData();
    formData.append('text', newComment);
    formData.append('lang', 'en');
    formData.append('mode', 'standard');
    formData.append('api_user', MODERATION_API_USER);
    formData.append('api_secret', MODERATION_API_SECRET);
    const moderationResult = await moderateText(newComment, textModerationURL);
    if (moderationResult.link || moderationResult.profanity) return moderationResult;
    if (moderationResult.error) return moderationResult;
    try {

        const batch = db.batch();
        const postRef = db.collection(collectionType).doc(focusedPost.id)
        const docRef = db.collection(collectionType).doc(focusedPost.id).collection('comments').doc()
        const profileCommentRef = db.collection('profiles').doc(user).collection('comments').doc(docRef.id)
        const profileCheckRef = db.collection('profiles').doc(focusedPost.userId).collection('checkNotifications').doc()
        const profileRef = db.collection('profiles').doc(focusedPost.userId).collection('notifications').doc(docRef.id)
        batch.set(docRef, {
            comment: newComment,
            pfp: pfp,
            blockedUsers: blockedUsers,
            notificationToken: notificationToken,
            username: username,
            timestamp: FieldValue.serverTimestamp(),
            likedBy: [],
            replies: [],
            user: user,
            postId: focusedPost.id
        })
        batch.update(postRef, {
            comments: FieldValue.increment(1)
        })
        batch.set(profileRef, {
            like: false,
            comment: true,
            friend: false,
            item: newComment,
            request: false,
            acceptRequest: false,
            theme: false,
            postId: focusedPost.id,
            report: false,
            requestUser: user,
            video: collectionType == 'video' ? true : false,
            requestNotificationToken: focusedPost.notificationToken,
            likedBy: username,
            timestamp: FieldValue.serverTimestamp()
        })
        batch.set(profileCommentRef, {
            comment: newComment,
            username: username, 
            timestamp: FieldValue.serverTimestamp(),
            user: user,
            postId: focusedPost.id
        })
        batch.set(profileCheckRef, {
            userId: user
        })
        await batch.commit();
        return { done: true };
    } catch (error) {
        console.error(error);
        return { error: 'Failed to add reply to comment.' };
    }
}
async function addCommentUsername(data, collectionType) {
  console.log(collectionType)
    const { focusedPost, newComment, blockedUsers, pfp, notificationToken, userId, username, textModerationURL } = data.data;
    const formData = new FormData();
    formData.append('text', newComment);
    formData.append('lang', 'en');
    formData.append('mode', 'standard');
    formData.append('api_user', MODERATION_API_USER);
    formData.append('api_secret', MODERATION_API_SECRET);
    const moderationResult = await moderateText(newComment, textModerationURL);
    if (moderationResult.link || moderationResult.profanity) return moderationResult;
    if (moderationResult.error) return moderationResult;
    try {

        const batch = db.batch();
        const docRef = db.collection(collectionType).doc(focusedPost.id).collection('comments').doc()
        const postRef = db.collection(collectionType).doc(focusedPost.id)
        console.log(`Document Ref: ${docRef.id}`)
        const profileCommentRef = db.collection('profiles').doc(userId).collection('comments').doc(docRef.id)
        batch.set(docRef, {
            comment: newComment,
            pfp: pfp,
            blockedUsers: blockedUsers,
            notificationToken: notificationToken,
            username: username,
            timestamp: FieldValue.serverTimestamp(),
            likedBy: [],
            replies: [],
            user: userId,
            postId: focusedPost.id
        })
        batch.update(postRef, {
            comments: FieldValue.increment(1)
        })
        batch.set(profileCommentRef, {
            comment: newComment,
            username: username, 
            timestamp: FieldValue.serverTimestamp(),
            user: userId,
            postId: focusedPost.id
        })
        await batch.commit();
        return { done: true };
    } catch (error) {
        console.error(error);
        return { error: 'Failed to add reply to comment.' };
    }
}
async function addReplyToReplyUsername(data, collectionType) {
    const { focusedPost, newComment, tempCommentId, textModerationURL, newReply } = data.data;
    const formData = new FormData();
    formData.append('text', newReply.reply);
    formData.append('lang', 'en');
    formData.append('mode', 'standard');
    formData.append('api_user', MODERATION_API_USER);
    formData.append('api_secret', MODERATION_API_SECRET);
    const moderationResult = await moderateText(newReply.reply, textModerationURL);
    if (moderationResult.link || moderationResult.profanity) return moderationResult;
    if (moderationResult.error) return moderationResult;
    try {
        const batch = db.batch();
        const commentDocRef = db.collection(collectionType).doc(focusedPost.id).collection('comments').doc(tempCommentId);
        // Reference to the video document
        const postDocRef = db.collection(collectionType).doc(focusedPost.id);
        batch.update(commentDocRef, {
            replies: FieldValue.arrayUnion(newReply),
        });
        batch.update(postDocRef, {
            comments: FieldValue.increment(1),
        });
        await batch.commit();
        return { done: true };
    } catch (error) {
        console.error(error);
        return { error: 'Failed to add reply to comment.' };
    }
}
async function addReplyToReply(data, collectionType) {
    const { focusedPost, newComment, tempCommentId, commentSnap, textModerationURL, reply, newReply, userId, username } = data.data;
    const formData = new FormData();
    formData.append('text', newReply.reply);
    formData.append('lang', 'en');
    formData.append('mode', 'standard');
    formData.append('api_user', MODERATION_API_USER);
    formData.append('api_secret', MODERATION_API_SECRET);
    const moderationResult = await moderateText(newReply.reply, textModerationURL);
    if (moderationResult.link || moderationResult.profanity) return moderationResult;
    if (moderationResult.error) return moderationResult;
    try {
        const batch = db.batch();
        const commentDocRef = db.collection(collectionType).doc(focusedPost.id).collection('comments').doc(tempCommentId)
        const postRef = db.collection(collectionType).doc(focusedPost.id)
        const profileRef = db.collection('profiles').doc(commentSnap.user).collection('notifications').doc()
        const profileCheckRef = db.collection('profiles').doc(commentSnap.user).collection('checkNotifications').doc()
        batch.update(commentDocRef, {
            replies: FieldValue.arrayUnion(newReply),
        });
        batch.update(postRef, {
            comments: FieldValue.increment(1),
        });
        batch.set(profileRef, {
            like: false,
            reply: true,
            friend: false,
            item: reply,
            request: false,
            acceptRequest: false,
            postId: focusedPost.id, 
            theme: false,
            report: false,
            requestUser: userId,
            requestNotificationToken: focusedPost.notificationToken,
            likedBy: username,
            timestamp: FieldValue.serverTimestamp()
        })
        batch.set(profileCheckRef, {
            userId: userId
        })
        await batch.commit();
        return { done: true };
    } catch (error) {
        console.error(error);
        return { error: 'Failed to add reply to comment.' };
    }
}
const deleteMessageHelper = async (itemId, itemUser, itemToUser, image = null, friendId, newMessageId = null, newMessageTimestamp = null) => {
  const batch = db.batch();
  const deletedMessageRef = db.collection('deletedMessages').doc(itemId);
  const friendChatRef = db.collection('friends').doc(friendId).collection('chats').doc(itemId);
  const friendRef = db.collection('friends').doc(friendId);
  batch.set(deletedMessageRef, {
    user: itemUser,
    toUser: itemToUser,
    timestamp: FieldValue.serverTimestamp()
  });

  // Delete the message from the friend's chat
  batch.delete(friendChatRef);

  // Update the friend record with the new message or null if no new message
  const updateData = newMessageId ? {
    messageId: newMessageId,
    lastMessageTimestamp: newMessageTimestamp,
    lastMessage: { text: 'User deleted message' }
  } : {
    messageId: null,
    lastMessageTimestamp: FieldValue.serverTimestamp(),
    lastMessage: null,
    toUser: null
  };
  batch.update(friendRef, updateData);

  await batch.commit();
  
  // Handle the file deletion
  if (image) {
    const filePath = decodeURIComponent(image.split('/o/')[1].split('?')[0]);
    await admin.storage().bucket().file(filePath).delete();
  }
  
};
const updateProfile = (post, profile, userId, url, themeName, price, sellChecked) => {
  const profileRef = db.collection('profiles').doc(userId);

  // Define the fields to update
  const updateFields = {
    themeName: themeName.trim(),
    free: Number.parseFloat(price) > 0 ? false : true,
    forSale: sellChecked ? true : false,
    postBought: sellChecked ? true : false,
    credits: FieldValue.increment(-1)
  };

  // Add specific fields depending on post/profile condition
  if (post) {
    updateFields.postBackground = url;
  }

  if (profile) {
    updateFields.background = url;
  }
  if (!post && !profile) {
    profileRef.update({credits: FieldValue.increment(-1)})
  }
  // Perform update on the profile document and return the update operation
  return profileRef.update(updateFields);
};


async function createTheme(user, themeName, price, sellChecked, url, keywords, originalKeywords) {
  const myRef = db.collection('profiles').doc(user).collection('myThemes').doc();
  return {
    set: myRef.set({
      timestamp: FieldValue.serverTimestamp(),
      images: FieldValue.arrayUnion(url),
      active: true,
      name: themeName.trim(),
      keywords: originalKeywords,
      searchKeywords: keywords,
      bought: false,
      forSale: sellChecked ? true : false,
      price: Number.parseFloat(price),
    }),
    ref: myRef
  };
}

const createFreeTheme = async(themeRef, userId, themeName, originalKeywords, keywords, sellChecked) => {
  const freeRef = db.collection('freeThemes').doc(themeRef.id);
  return {
    free: freeRef.set({
      timestamp: FieldValue.serverTimestamp(),
      images: FieldValue.arrayUnion(themeRef.id),
      active: true,
      userId: userId,
      name: themeName.trim(),
      keywords: originalKeywords,
      searchKeywords: keywords,
      bought: false,
      forSale: sellChecked ? true : false,
      bought_count: 0,
      stripe_metadata_price: 0
    })
  };
};

app.post('/api/newReplyVideoUsername', async (req, res) => {
    const result = await addReplyUsername(req.body, 'videos');
    res.status(result.done ? 200 : 500).json(result);
});
app.post('/api/newReplyUsername', async (req, res) => {
    const result = await addReplyUsername(req.body, 'posts');
    res.status(result.done ? 200 : 500).json(result);
});
app.post('/api/newReply', async (req, res) => {
    const result = await addReply(req.body, 'posts');
    res.status(result.done ? 200 : 500).json(result);
})
app.post('/api/newReplyVideo', async(req, res) => {
    const result = await addReply(req.body, 'videos');
    res.status(result.done ? 200 : 500).json(result);
})
app.post('/api/newCommentVideo', async(req, res) => {
    const result = await addComment(req.body, 'videos');
    res.status(result.done ? 200 : 500).json(result);
})
app.post('/api/newComment', async(req, res) => {
    const result = await addComment(req.body, 'posts');
    res.status(result.done ? 200 : 500).json(result);
})
app.post('/api/newCommentVideoUsername', async(req, res) => {
    const result = await addCommentUsername(req.body, 'videos');
    res.status(result.done ? 200 : 500).json(result);
})
app.post('/api/newCommentUsername', async(req, res) => {
    const result = await addCommentUsername(req.body, 'posts');
    res.status(result.done ? 200 : 500).json(result);
})
app.post('/api/newReplyToReplyVideoUsername', async(req, res) => {
    const result = await addReplyToReplyUsername(req.body, 'videos');
    res.status(result.done ? 200 : 500).json(result);
})
app.post('/api/newReplyToReplyUsername', async(req, res) => {
    const result = await addReplyToReplyUsername(req.body, 'posts');
    res.status(result.done ? 200 : 500).json(result);
})
app.post('/api/newReplyToReplyVideo', async(req, res) => {
    const result = await addReplyToReply(req.body, 'videos');
    res.status(result.done ? 200 : 500).json(result);
})
app.post('/api/newReplyToReply', async(req, res) => {
    const result = await addReplyToReply(req.body, 'posts');
    res.status(result.done ? 200 : 500).json(result);
})
app.post('/api/deleteImageMessage', async (req, res) => {
  const data = req.body;
  const { item, image, friendId } = data.data;
  try {
    await deleteMessageHelper(item.id, item.user, item.toUser, image, friendId);
    res.status(200).json({ done: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete message.' });
  }
})
app.post('/api/deleteImageMessageNewMessage', async (req, res) => {
    const data = req.body
    const { item, image, friendId, newMessageId, newMessageTimestamp } = data.data;
    try {
      await deleteMessageHelper(item.id, item.user, item.toUser, image, friendId, newMessageId, newMessageTimestamp);
      res.status(200).json({ done: true });
    }
    catch (error) {
      console.error(error)
      res.status(500).json({ error: 'Failed to delete message.' });
    }
  })
app.post('/api/deleteMessageNewMessage', async (req, res) => {
    const data = req.body
    const { itemId, itemToUser, itemUser, friendId, newMessageId, newMessageTimestamp } = data.data;
    try {
      await deleteMessageHelper(itemId, itemUser, itemToUser, null, friendId, newMessageId, newMessageTimestamp);
      res.status(200).json({ done: true });
    }
    catch (error) {
      console.error(error)
      res.status(500).json({ error: 'Failed to delete message.' });
    }
  })
app.post('/api/deleteMessage', async (req, res) => {
    const data = req.body
    const { itemId, itemToUser, itemUser, friendId} = data.data;
    try {
      await deleteMessageHelper(itemId, itemUser, itemToUser, null, friendId);
      res.status(200).json({ done: true });
    }
    catch (error) {
      console.error(error)
      res.status(500).json({ error: 'Failed to delete message.' });
    }
  })
app.post('/api/deletePost', async (req, res) => {
    const data = req.body;
  const id = data.data.id
  const userId = data.data.user
  try {
    const batch = db.batch();
    const deletedRef = db.collection('deletedPosts').doc(id.id)
    const postRef = db.collection('posts').doc(id.id)
    const profileRef = db.collection('profiles').doc(userId).collection('posts').doc(id.id)
    if (id.post[0].image) {
        batch.set(deletedRef, {
            info: id,
            username: id.username,
            userId: id.userId,
            timestamp: FieldValue.serverTimestamp()
        })
        batch.delete(postRef)
        batch.delete(profileRef)
        await batch.commit();
        const deleteFilePromises = id.post.map(async (e) => {
            const filePath = decodeURIComponent(e.split('/o/')[1].split('?')[0]);
            return admin.storage().bucket().file(filePath).delete();
        });
        // Wait for all file deletions to complete
        await Promise.all(deleteFilePromises);
        // Respond to the client
        res.status(200).json({ done: true });
    }
    else {
        batch.set(deletedRef, {
            info: id,
            username: id.username,
            userId: id.userId,
            timestamp: FieldValue.serverTimestamp()
        })
        batch.delete(postRef)
        batch.delete(profileRef)
        await batch.commit();
        res.status(200).json({ done: true });
    }
  }
  catch (error) {
        console.error(error)
        res.status(500).json({ error: 'Failed to delete post.' });
    }
})
app.post('/api/acceptRequestInd', async (req, res) => {
  const data = req.body
  const userId = data.data.user
  const newUser = data.data.newUser
  const item = data.data.item
  const username = data.data.username
  const smallKeywords = data.data.smallKeywords
  const largeKeywords = data.data.largeKeywords
  let friendUsername = (await db.collection('profiles').doc(item.item.requestUser).get()).data().searchusername
  let friendSmallkeywords = (await db.collection('profiles').doc(item.item.requestUser).get()).data().smallKeywords
  let friendLargekeywords = (await db.collection('profiles').doc(item.item.requestUser).get()).data().largeKeywords
  let existingFriend = (await db.collection('profiles').doc(item.item.requestUser).collection('friends').doc(userId).get())
  let message = (await db.collection('friends').doc(newUser).get())
  await db.collection('profiles').doc(userId).collection('notifications').doc(item.item.id).delete().then(async() => 
    await db.collection('profiles').doc(userId).collection('requests').doc(item.item.requestUser).delete()).then(async() => 
      await db.collection('profiles').doc(item.item.requestUser).collection('requests').doc(userId).delete()).then(async() => {
    if (existingFriend.exists) {
      if (existingFriend.data().actualFriend == true) {
        await db.collection('profiles').doc(userId).collection('friends').doc(item.item.requestUser).set({
          friendId: newUser,
          actualFriend: true,
          searchusername: friendUsername,
          smallKeywords: friendSmallkeywords,
          largeKeywords: friendLargekeywords,
          previousFriend: true,
          timestamp: FieldValue.serverTimestamp(),
          lastMessageTimestamp: FieldValue.serverTimestamp()
        }).then(async() => await db.collection('profiles').doc(item.item.requestUser).collection('friends').doc(userId).set({
          friendId: newUser,
          actualFriend: true,
          searchusername: username.toLowerCase(),
          smallKeywords: smallKeywords,
          largeKeywords: largeKeywords,
          previousFriend: true,
          timestamp: FieldValue.serverTimestamp(),
          lastMessageTimestamp: FieldValue.serverTimestamp()
        })).then(async() => await db.collection('friends').doc(newUser).set({
            lastMessageTimestamp: FieldValue.serverTimestamp(),
            active: true,
            users: [item.item.requestUser, userId]
          })).then(async() => await db.collection('profiles').doc(userId).update({
            followers: FieldValue.arrayUnion(item.item.requestUser)
          })).then(async() => await db.collection('profiles').doc(item.item.requestUser).update({
            following: FieldValue.arrayUnion(userId)
          })).then(() => db.collection('profiles').doc(item.item.requestUser).collection('notifications').add({
          like: false,
          comment: false,
          friend: true,
          item: null,
          request: false,
          acceptRequest: true,
          postId: null,
          theme: false,
          report: false,
          requestUser: userId,
          requestNotificationToken: item.info.notificationToken,
          likedBy: [],
          timestamp: FieldValue.serverTimestamp()
        })).then(() => db.collection('profiles').doc(item.item.requestUser).collection('checkNotifications').add({
          userId: item.item.requestUser
        }))
        res.send({done: true})
      }
      else if (existingFriend.data().actualFriend == false) {
      await db.collection('profiles').doc(item.item.requestUser).collection('friends').doc(userId).set({
          friendId: newUser,
          actualFriend: true,
          previousFriend: true,
          timestamp: FieldValue.serverTimestamp(),
          lastMessageTimestamp: FieldValue.serverTimestamp()
        }).then(async() => await db.collection('friends').doc(newUser).set({
          lastMessageTimestamp: FieldValue.serverTimestamp(),
          active: true,
          users: [item.item.requestUser, userId]
        })).then(async() => await db.collection('profiles').doc(userId).update({
          followers: FieldValue.arrayUnion(item.item.requestUser)
        })).then(async() => await db.collection('profiles').doc(item.item.requestUser).update({
          following: FieldValue.arrayUnion(userId)
        })).then(() => db.collection('profiles').doc(item.item.requestUser).collection('notifications').add({
          like: false,
          comment: false,
          friend: true,
          item: null,
          request: false,
          acceptRequest: true,
          postId: null,
          theme: false,
          report: false,
          requestUser: userId,
          requestNotificationToken: item.info.notificationToken,
          likedBy: [],
          timestamp: FieldValue.serverTimestamp()
        })).then(() => db.collection('profiles').doc(item.item.requestUser).collection('checkNotifications').add({
          userId: item.item.requestUser
        }))
        res.send({done: true})
      }
    }
    else {
     await db.collection('profiles').doc(userId).collection('friends').doc(item.item.requestUser).set({
          friendId: newUser,
          actualFriend: false,
          previousFriend: true,
          timestamp: FieldValue.serverTimestamp(),
          lastMessageTimestamp: FieldValue.serverTimestamp()
        }).then(async() => await db.collection('profiles').doc(item.item.requestUser).collection('friends').doc(userId).set({
          friendId: newUser,
          actualFriend: true,
          previousFriend: true,
          timestamp: FieldValue.serverTimestamp(),
          lastMessageTimestamp: FieldValue.serverTimestamp()
        })).then(async() => await db.collection('profiles').doc(userId).update({
          followers: FieldValue.arrayUnion(item.item.requestUser)
        })).then(async() => await db.collection('profiles').doc(item.item.requestUser).update({
          following: FieldValue.arrayUnion(userId)
        })).then(() => db.collection('profiles').doc(item.item.requestUser).collection('notifications').add({
          like: false,
          comment: false,
          friend: true,
          item: null,
          request: false,
          acceptRequest: true,
          postId: null,
          theme: false,
          report: false,
          requestUser: userId,
          requestNotificationToken: item.info.notificationToken,
          likedBy: [],
          timestamp: FieldValue.serverTimestamp()
        })).then(() => db.collection('profiles').doc(item.item.requestUser).collection('checkNotifications').add({
          userId: item.item.requestUser
        }))
        res.send({done: true})
    }
    
   }
  )
  res.send({done: true})
})
app.post('/api/uploadCliq', async (req, res) => {
      const data = req.body
      const id = data.data.groupId
      const userId = data.data.user
      const name = data.data.name 
      const banner = data.data.banner
      const groupSecurity = data.data.groupSecurity
      const category = data.data.category
      const description = data.data.description
      const searchKeywords = data.data.searchKeywords
      await db.collection('groups').doc(id).set({
        banner: banner,
        name: name.trim(),
        flagged: 0,
        member_count: 1,
        groupSecurity: groupSecurity,
        category: category,
        description: description.trim(),
        paused: false,
        members: FieldValue.arrayUnion(userId),
        admins: FieldValue.arrayUnion(userId),
        allowPostNotifications: FieldValue.arrayUnion(userId),
        allowMessageNotifications: FieldValue.arrayUnion(userId),
        timestamp: FieldValue.serverTimestamp(),
        requestsSent: [],
        searchkeywords: searchKeywords,
        adminContacts: [],
        bannedUsers: []
      }).then(async() => await db.collection('profiles').doc(userId).update({
          groupsJoined: FieldValue.arrayUnion(id),
          adminGroups: FieldValue.arrayUnion(id)
        })).then(async() => await db.collection('groups').doc(id).collection('channels').doc(id).set({
        members: FieldValue.arrayUnion(userId),
        lastMessageTimestamp: FieldValue.serverTimestamp(),
        name: `${name.trim()} General`,
        security: 'public',
        member_count: FieldValue.increment(1),
        admins: [userId],
        official: true,
        allowNotifications: FieldValue.arrayUnion(userId)
    })).then(async() => await db.collection('profiles').doc(userId).collection('channels').doc(id).set({
        channelsJoined: FieldValue.arrayUnion(id)
    })).then(async() => await db.collection('groups').doc(id).collection('profiles').doc(userId).set({
      searchKeywords: searchKeywords
    }))
    res.send({done: true})
    })
app.post('/api/uploadStory', async(req, res) => {
        const data = req.body
        const userId = data.data.user
        const background = data.data.background
        const forSale = data.data.forSale
        const post = data.data.post
        const docRef = await db.collection('profiles').doc(userId).collection('stories').add({
          userId: userId,
          
          post: post,
          forSale: forSale,
          reportedIds: [],
          
          likedBy: [],

          usersSeen: [],
         
          timestamp: FieldValue.serverTimestamp(),
          background: background
      })
      res.send({done: true})
  })
  app.post('/api/getFreeTheme', async(req, res) => {
  const data = req.body
  const userId = data.data.user
  const keywords = data.data.keywords
  const searchKeywords = data.data.searchKeywords
  const name = data.data.name
  const theme = data.data.theme
  const productId = data.data.productId
  const themeId = data.data.themeId
  const notificationToken = data.data.notificationToken
  try {
    const batch = db.batch();
    const purchasedRef = db.collection('profiles').doc(userId).collection('purchased').doc()
    const freeRef = db.collection('freeThemes').doc(productId)
    const profileRef = db.collection('profiles').doc(userId)
    const notificationsRef = db.collection('profiles').doc(userId).collection('notifications').doc()
    batch.set(purchasedRef, {
      active: true,
      keywords: keywords,
      searchKeywords: searchKeywords,
      name: name,
      images: FieldValue.arrayUnion(theme),
      price: 0,
      timestamp: FieldValue.serverTimestamp(),
      bought: true,
      productId: productId,
      selling: true
    })
    batch.update(freeRef, {
      bought_count: FieldValue.increment(1)
    })
    batch.update(profileRef, {
      themeIds: FieldValue.arrayUnion(productId)
    })
    batch.set(notificationsRef, {
      like: false,
      comment: false,
      friend: false,
      item: themeId,
      request: false,
      acceptRequest: false,
      postId: themeId,
      theme: true,
      report: false,
      requestUser: userId,
      requestNotificationToken: notificationToken,
      likedBy: [],
      timestamp: FieldValue.serverTimestamp()
    })
    await batch.commit();
    res.status(200).json({ done: true });
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: 'Failed to add reply to comment.' });
  }
})
app.post('/api/profilepostnotsell', async (req, res) => {
  const data = req.body;
  const { user, url, sellChecked, themeName, price, keywords, originalKeywords } = data.data;
  try {
    const batch = db.batch();
    batch.update(await updateProfile(true, true, user, url, themeName, price, sellChecked));
    const themeCreation = await createTheme(user, themeName, price, sellChecked, url, keywords, originalKeywords)
    batch.set(themeCreation.set)
    batch.commit();
    res.status(200).json({ done: true });
  } catch (error) {
    console.error("Error processing request: ", error);
    res.status(500).send("Error processing request");
  }
});
app.post('/api/postnotprofilenotsell', async (req, res) => {
  const data = req.body;
  const { user, url, sellChecked, themeName, price, keywords, originalKeywords } = data.data;
  try {
    const batch = db.batch();
    const themeCreation = await createTheme(user, themeName, price, sellChecked, url, keywords, originalKeywords)
    batch.set(themeCreation.set)
    batch.update(await updateProfile(true, false, user, url, themeName, price, sellChecked));
    batch.commit();
    res.status(200).json({ done: true });
  } catch (error) {
    console.error("Error processing request: ", error);
    res.status(500).send("Error processing request");
  }
});
app.post('/api/sellpostnotprofile', async (req, res) => {
  const data = req.body;
  const { user, url, sellChecked, themeName, price, keywords, originalKeywords } = data.data;
  try {
    const batch = db.batch();
    batch.update(await updateProfile(true, false, user, url, themeName, price, sellChecked))
    const themeCreation = await createTheme(user, themeName, price, sellChecked, url, keywords, originalKeywords);
    batch.set(themeCreation.set)
    const freeCreation = await createFreeTheme(themeCreation.ref, user, themeName, originalKeywords, keywords, sellChecked);
    batch.set(freeCreation.free)
    batch.commit();
    res.status(200).json({ done: true });
  } catch (error) {
    console.error("Error processing request: ", error);
    res.status(500).send("Error processing request");
  }
});
  app.post('/api/sellprofilenotpost', async (req, res) => {
  const data = req.body;
  const { user, url, sellChecked, themeName, price, keywords, originalKeywords } = data.data;
  try {
    const batch = db.batch();
    batch.update(await updateProfile(false, true, user, url, themeName, price, sellChecked))
    const themeRef = await createTheme(user, themeName, price, sellChecked, url, keywords, originalKeywords);
    batch.set(themeRef.set)
    const freeCreation = await createFreeTheme(themeRef.ref, user, themeName, originalKeywords, keywords, sellChecked);
    batch.set(freeCreation.free)
    batch.commit();
    res.status(200).json({ done: true });
  } catch (error) {
    console.error("Error processing request: ", error);
    res.status(500).send("Error processing request");
  }
});
  app.post('/api/profilenotpostnotsell', async (req, res) => {
      const data = req.body
      const {user, url, sellChecked, themeName, price, keywords, originalKeywords} = data.data
      try {
        const batch = db.batch();
        const themeCreation = await createTheme(user, themeName, price, sellChecked, url, keywords, originalKeywords)
        batch.set(themeCreation.set)
        batch.update(await updateProfile(false, true, user, url, themeName, price, sellChecked));
        await batch.commit();
        res.status(200).json({ done: true });
      }
      catch (error) {
        console.error(error)
        res.status(500).send("Error")
      }
    })
  app.post('/api/sellprofilepost', async (req, res) => {
      const data = req.body
      const {user, url, sellChecked, themeName, price, keywords, originalKeywords} = data.data
      try {
        const batch = db.batch();
        batch.update(await updateProfile(true, true, user, url, themeName, price, sellChecked))
        const themeRef = await createTheme(user, themeName, price, sellChecked, url, keywords, originalKeywords);
        batch.set(themeRef.set)
        const freeCreation = await createFreeTheme(themeRef.ref, user, themeName, originalKeywords, keywords, sellChecked);
        batch.set(freeCreation.free)
        await batch.commit();
        res.status(200).json({ done: true });
      } 
      catch (error) {
        console.error("Error processing request: ", error);
        res.status(500).send("Error processing request"); 
      }
    })
app.post('/api/sellnotprofilenotpost', async (req, res) => {
  const data = req.body;
  const {user, url, sellChecked, themeName, price, keywords, originalKeywords} = data.data
  try {
    const batch = db.batch();
    batch.update(await updateProfile(false, false, user, url, themeName, price, sellChecked))
    const themeRef = await createTheme(user, themeName, price, sellChecked, url, keywords, originalKeywords);
    batch.set(themeRef.set)
    const freeCreation = await createFreeTheme(themeRef.ref, user, themeName, originalKeywords, keywords, sellChecked);
    batch.set(freeCreation.free)
    await batch.commit();
    res.status(200).json({ done: true });
  } catch (error) {
    console.error("Error processing request: ", error);
    res.status(500).send("Error processing request"); 
  }
});
app.post('/api/notsellnotprofilenotpost', async (req, res) => {
    const data = req.body
    const {user, url, sellChecked, themeName, price, keywords, originalKeywords} = data.data
    try {
      const batch = db.batch();
      const themeCreation = await createTheme(user, themeName, price, sellChecked, url, keywords, originalKeywords)
      batch.set(themeCreation.set)
      batch.update(await updateProfile(false, false, user, url, themeName, price, sellChecked));
      await batch.commit();
      res.status(200).json({ done: true });
    } catch (error) {
      console.error(error)
      res.status(500).send("Error")
    }
  })
app.post('/api/privacy', async(req, res) => {
    const data = req.body
    const {newValue, user} = data.data
    try {
      const batch = db.batch();
      const profileRef =  db.collection('profiles').doc(user)
      batch.update(profileRef, {
        private: newValue
      })
      await batch.commit();
      res.status(200).json({ done: true })
    } 
    catch (error) {
      console.error(error)
      res.status(500).send(error)
    }
  })
app.post('/api/addFriend', async(req,res) => {
    const data = req.body
    const newFriend = data.data.newFriend
    const item = data.data.item
    const username = data.data.username
    const smallKeywords = data.data.smallKeywords
    const largeKeywords = data.data.largeKeywords
    const userId = data.data.user
    let privacy = (await db.collection('profiles').doc(item.userId).get()).data().private
    let friendUsername = (await db.collection('profiles').doc(item.userId).get()).data().searchusername
    let friendSmallkeywords = (await db.collection('profiles').doc(item.userId).get()).data().smallKeywords
    let friendLargekeywords = (await db.collection('profiles').doc(item.userId).get()).data().largeKeywords
    let existingUserFriend = (await db.collection('profiles').doc(userId).collection('friends').doc(item.userId).get())
    let existingFriend = (await db.collection('profiles').doc(item.userId).collection('friends').doc(userId).get())
    let message = (await db.collection('friends').doc(newFriend).get())
    console.log(privacy)
    if (existingUserFriend.exists && existingFriend.exists) {
      if (existingUserFriend.data().actualFriend == false && existingFriend.data().actualFriend == true) {
        if (privacy) {
          await db.collection('profiles').doc(userId).collection('requests').doc(item.userId).set({
            id: item.userId,
          actualRequest: true,
          timestamp: FieldValue.serverTimestamp()
          }).then(async() => await db.collection('profiles').doc(item.userId).collection('requests').doc(userId).set({
          id: userId,
          actualRequest: false,
          timestamp: FieldValue.serverTimestamp()
        })).then(() => db.collection('profiles').doc(item.userId).collection('notifications').add({
          like: false,
          comment: false,
          friend: true,
          item: null,
          request: true,
          acceptRequest: false,
          postId: item.id,
          theme: false,
          report: false,
          requestUser: userId,
          requestNotificationToken: item.notificationToken,
          likedBy: [],
          timestamp: FieldValue.serverTimestamp()
        })).then(() => db.collection('profiles').doc(item.userId).collection('checkNotifications').add({
          userId: item.userId
        }))
        res.send({ request: true, friend: false })
        }
        else if (!privacy) {
          await db.collection('profiles').doc(userId).collection('friends').doc(item.userId).set({
          friendId: newFriend,
          actualFriend: true,
          searchusername: friendUsername,
          smallKeywords: friendSmallkeywords,
          largeKeywords: friendLargekeywords,
          previousFriend: true,
          timestamp: FieldValue.serverTimestamp(),
          lastMessageTimestamp: FieldValue.serverTimestamp(),
        }).then(async() => await db.collection('profiles').doc(item.userId).collection('friends').doc(userId).set({
          friendId: newFriend,
          actualFriend: true,
          searchusername: username.toLowerCase(),
          smallKeywords: smallKeywords,
          largeKeywords: largeKeywords,
          previousFriend: true,
          timestamp: FieldValue.serverTimestamp(),
          lastMessageTimestamp: FieldValue.serverTimestamp()
        })).then(message.exists ? async() => await db.collection('friends').doc(newFriend).update({
            active: true,
            users: [item.userId, userId]
          }) : async() => await db.collection('friends').doc(newFriend).set({
            lastMessageTimestamp: FieldValue.serverTimestamp(),
            active: true,
            users: [item.userId, userId]
          })).then(() => db.collection('profiles').doc(item.userId).collection('notifications').add({
          like: false,
          comment: false,
          friend: true,
          item: null,
          request: false,
          acceptRequest: false,
          postId: null,
          theme: false,
          report: false,
          requestUser: userId,
          requestNotificationToken: item.notificationToken,
          likedBy: [],
          timestamp: FieldValue.serverTimestamp()
        })).then(() => db.collection('profiles').doc(item.userId).collection('checkNotifications').add({
          userId: item.userId
        })).then(async() => await db.collection('profiles').doc(userId).update({
          following: FieldValue.arrayUnion(item.userId)
        })).then(async() => await db.collection('profiles').doc(item.userId).update({
          followers: FieldValue.arrayUnion(userId)
        }))
        res.send({ request: false, friend: true })
        }
          
          }
      else if (existingUserFriend.data().actualFriend == false && existingFriend.data().actualFriend == false) {
        if (privacy) {
          await db.collection('profiles').doc(userId).collection('requests').doc(item.userId).set({
          id: item.userId,
          actualRequest: true,
          timestamp: FieldValue.serverTimestamp()
        }).then(async() => await db.collection('profiles').doc(item.userId).collection('requests').doc(userId).set({
          id: userId,
          actualRequest: false,
          timestamp: FieldValue.serverTimestamp()
        })).then(() => db.collection('profiles').doc(item.userId).collection('notifications').add({
          like: false,
          comment: false,
          friend: true,
          item: null,
          request: true,
          acceptRequest: false,
          postId: item.id,
          theme: false,
          report: false,
          requestUser: userId,
          requestNotificationToken: item.notificationToken,
          likedBy: [],
          timestamp: FieldValue.serverTimestamp()
        })).then(() => db.collection('profiles').doc(item.userId).collection('checkNotifications').add({
          userId: item.userId
        }))
        res.send({ request: true, friend: false })
        }
        else if (!privacy) {
          
              await db.collection('profiles').doc(userId).collection('friends').doc(item.userId).set({
          friendId: newFriend,
          actualFriend: true,
          previousFriend: true,
          timestamp: FieldValue.serverTimestamp(),
          lastMessageTimestamp: FieldValue.serverTimestamp()
        }).then(async() => await db.collection('profiles').doc(item.userId).collection('friends').doc(userId).set({
          friendId: newFriend,
          actualFriend: false,
          previousFriend: true,
          timestamp: FieldValue.serverTimestamp(),
          lastMessageTimestamp: FieldValue.serverTimestamp()
        })).then(async() => await db.collection('profiles').doc(userId).update({
          following: FieldValue.arrayUnion(item.userId)
        })).then(async() => await db.collection('profiles').doc(item.userId).update({
          followers: FieldValue.arrayUnion(userId)
        })).then(() => db.collection('profiles').doc(item.userId).collection('notifications').add({
          like: false,
          comment: false,
          friend: true,
          item: null,
          request: false,
          acceptRequest: false,
          postId: item.id,
          theme: false,
          report: false,
          requestUser: userId,
          requestNotificationToken: item.notificationToken,
          likedBy: [],
          timestamp: FieldValue.serverTimestamp()
        })).then(() => db.collection('profiles').doc(item.userId).collection('checkNotifications').add({
          userId: item.userId
        }))
        res.send({ request: false, friend: true })
        }
      }
        }
    else {
      if (privacy) {
          await db.collection('profiles').doc(userId).collection('requests').doc(item.userId).set({
          id: item.userId,
          actualRequest: true,
          timestamp: FieldValue.serverTimestamp()
        }).then(async() => await db.collection('profiles').doc(item.userId).collection('requests').doc(userId).set({
          id: userId,
          actualRequest: false,
          timestamp: FieldValue.serverTimestamp()
        })).then(() => db.collection('profiles').doc(item.userId).collection('notifications').add({
          like: false,
          comment: false,
          friend: true,
          item: null,
          request: true,
          acceptRequest: false,
          postId: item.id,
          theme: false,
          report: false,
          requestUser: userId,
          requestNotificationToken: item.notificationToken,
          likedBy: [],
          timestamp: FieldValue.serverTimestamp()
        })).then(() => db.collection('profiles').doc(item.userId).collection('checkNotifications').add({
          userId: item.userId
        }))
        res.send({ request: true, friend: false })
        }
        else if (!privacy) {
              await db.collection('profiles').doc(userId).collection('friends').doc(item.userId).set({
          friendId: newFriend,
          actualFriend: true,
          previousFriend: false,
          timestamp: FieldValue.serverTimestamp(),
          lastMessageTimestamp: FieldValue.serverTimestamp()
        }).then(async() => await db.collection('profiles').doc(item.userId).collection('friends').doc(userId).set({
          friendId: newFriend,
          actualFriend: false,
          previousFriend: true,
          timestamp: FieldValue.serverTimestamp(),
          lastMessageTimestamp: FieldValue.serverTimestamp()
        })).then(async() => await db.collection('profiles').doc(userId).update({
          following: FieldValue.arrayUnion(item.userId)
        })).then(async() => await db.collection('profiles').doc(item.userId).update({
          followers: FieldValue.arrayUnion(userId)
        })).then(() => db.collection('profiles').doc(item.userId).collection('notifications').add({
          like: false,
          comment: false,
          friend: true,
          item: null,
          request: false,
          acceptRequest: false,
          postId: item.id,
          theme: false,
          report: false,
          requestUser: userId,
          requestNotificationToken: item.notificationToken,
          likedBy: [],
          timestamp: FieldValue.serverTimestamp()
        })).then(() => db.collection('profiles').doc(item.userId).collection('checkNotifications').add({
          userId: item.userId
        }))
        res.send({ request: false, friend: true })
            }
    }
  })
app.post('/api/deleteRePost', async(req, res) => {
  const data = req.body
  const id = data.data.id
  const userId = data.data.user      
  try {
    const batch = db.batch();
    const deletedRepostsRef = db.collection('deletedReposts').doc(id.id)
    const postRef = db.collection('posts').doc(id.id).delete()
    const profileRef = db.collection('profiles').doc(userId).collection('posts').doc(id.id)
    batch.set(deletedRepostsRef, {
      info: id,
      username: id.username,
      userId: id.userId,
      timestamp: FieldValue.serverTimestamp()
    })
    batch.delete(postRef)
    batch.delete(profileRef)
    await batch.commit();
    res.status(200).json({ done: true })
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: 'Failed to delete repost' });
  }
})
app.post('/api/removeFriend', async (req, res) => {
  const data = req.body
  const friendId = data.data.friendId
  const userId = data.data.user
  const newFriend = data.data.newFriend
  console.log(data)
  try {
    const batch = db.batch();
    const userFriendRef = db.collection('profiles').doc(userId).collection('friends').doc(friendId)
    const toUserFriendRef = db.collection('profiles').doc(friendId).collection('friends').doc(userId)
    const friendRef = db.collection('friends').doc(newFriend)
    const profileRef = db.collection('profiles').doc(userId)
    const friendProfileRef = db.collection('profiles').doc(friendId)
    const docSnap = db.collection('friends').doc(newFriend).get();
    batch.update(userFriendRef, {
      actualFriend: false,
      previousFriend: true
    })
    batch.update(toUserFriendRef, {
      searchusername: null,
      smallKeywords: [],
      largeKeywords: []
    })
    if (docSnap.exists) {
      batch.update(friendRef, {
        active: false
      })
    }
    batch.update(profileRef, {
      following: FieldValue.arrayRemove(friendId)
    })
    batch.update(friendProfileRef, {
      followers: FieldValue.arrayRemove(friendId)
    })
    await batch.commit();
    res.status(200).json({ done: true });
  }
  catch (error) {
    console.error(error);
    res.status(500).send('Error removing Friend');
  }
  
})
app.post('/api/deleteTheme', async(req, res) => {
              const data = req.body
              const userId = data.data.user
              const item = data.data.item
              const background = data.data.background
              const postBackground = data.data.postBackground
              const theme = data.data.theme
              console.log(item)
              /* const filePath = decodeURIComponent(theme.split('/o/')[1].split('?')[0])
              await db.collection('profiles').doc(userId).collection('myThemes').doc(item.item.id).delete().then(async() => 
                await admin.storage().bucket().file(filePath).delete()).then(background == item.item.images[0] 
                && postBackground == item.item.images[0] ? async() => await db.collection('profiles').doc(userId).update({
                background: null,
                postBackground: null
            
              }).then(async() => {(await db.collection('posts').where('userId', '==', userId).get()).forEach(async(document) => {
                  await db.collection('posts').doc(document.id).update({
                    background: null
                  })
                })}) : postBackground == item.item.images[0] ? async() => await db.collection('profiles').doc(userId).update({
                postBackground: null
              }).then(async() => {(await db.collection('posts').where('userId', '==', userId).get()).forEach(async(document) => {
                  await db.collection('posts').doc(document.id).update({
                    background: null
                  })
                })}) : background == item.item.images[0] ? async() => await db.collection('profiles').doc(userId).update({
                background: null
              }) : null)
              if (item.item.forSale) {
                await db.collection('freeThemes').doc(item.item.id).delete()
              } */
              res.send({done: true})
            })

app.post('/api/likeVideoPost', async(req, res) => {
  const data = req.body
  const item = data.data.item
  const userId = data.data.user
  await db.collection('videos').doc(item.id).update({
    likedBy: FieldValue.arrayUnion(userId)
  }).then(async() => await db.collection('profiles').doc(userId).collection('likes').doc(item.id).set({
    post: item.id,
    video: true,
    timestamp: FieldValue.serverTimestamp()
  })).then(() => 
    db.collection('profiles').doc(item.userId).collection('notifications').add({
            like: true,
            comment: false,
            friend: false,
            item: item.id,
            video: true,
            request: false,
            acceptRequest: false,
            theme: false,
            report: false,
            postId: item.id,
            requestUser: userId,
            requestNotificationToken: item.notificationToken,
            likedBy: [],
            timestamp: FieldValue.serverTimestamp()
          }).then(() => db.collection('profiles').doc(item.userId).collection('checkNotifications').add({
              userId: item.userId
            })))
  res.send({done: true})
})
app.post('/api/blockUser', async (req, res) => {
    const data = req.body
    const name = data.data.name
    const userId = data.data.user
    await db.collection('profiles').doc(name).update({
      usersThatBlocked: FieldValue.arrayUnion(userId)
    }).then(async() => await db.collection('profiles').doc(userId).update({
      blockedUsers: FieldValue.arrayUnion(name)
    })).then(async() => (await db.collection('profiles').doc(userId).collection('posts').get()).forEach(async(e) => {
      if (e.data().post.length == 1 && e.data().post[0].video) {
      await db.collection('videos').doc(e.id).update({
        blockedUsers: FieldValue.arrayUnion(name)
      })
      }
      else {
      await db.collection('posts').doc(e.id).update({
        blockedUsers: FieldValue.arrayUnion(name)
      })
      }
      
    })).then(async() => {
     const friendSnap = await db.collection('profiles').doc(userId).collection('friends').doc(name).get()
     if (friendSnap.exists) {
      db.collection('friends').doc(friendSnap.data().friendId)
      
      await db.collection('friends').doc(friendSnap.data().friendId).delete().then(async() => 
        
        await db.collection('profiles').doc(userId).collection('friends').doc(name).delete())

      .then(async() => await db.collection('profiles').doc(name).collection('friends').doc(userId).delete())
     }
    })
    res.send({done: true})
  })
  app.post('/api/createAccount', async(req, res) => {
  const data = req.body
  const userId = data.data.user
  const firstName = data.data.firstName
  const lastName = data.data.lastName
  const userName = data.data.userName
  const age = data.data.age
  const pfp = data.data.pfp
  const token = data.data.token
  const bio = data.data.bio
  const smallKeywords = data.data.smallKeywords
  const largeKeywords = data.data.largeKeywords
  try {
    const batch = db.batch();
    const profileRef = db.collection('profiles').doc(userId)
    const usernameRef = db.collection('usernames').doc(userId)
    batch.set(profileRef, {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      userName: userName.trim(),
      active: true,
      banned: false,
      credits: 0,
      age: age,
      cliqChatActive: null,
      suspended: false,
      pfp: pfp,
      notificationToken: token,
      bio: bio.trim(),
      groupsJoined: [],
      eventsJoined: [],
      private: false,
      messageNotifications: [],
      messageActive: false,
      allowNotifications: true,
      stripeAccountID: null,
      showStatus: true,
      paymentMethodID: null,
      paymentMethodLast4: [],
      blockedUsers: [],
      background: null, 
      forSale: false,
      postBackground: null,
      reportedMessages: [],
      adminGroups: [],
      customerId: null,
      reportedComments: [],
      reportedPosts: [],
      reportedThemes: [],
      timestamp: FieldValue.serverTimestamp(),
      activeOnMessage: false,
      usersThatBlocked: [],
      bannedFrom: [],
      searchusername: userName.toLowerCase().trim(),
      smallKeywords: smallKeywords,
      largeKeywords: largeKeywords,
      timestamp: FieldValue.serverTimestamp()
    })
    batch.set(usernameRef, {
      username: userName.trim(),
    })
    await batch.commit();
    res.status(200).json({ done: true });
  }
  catch (error) {
    console.error(error)
    res.status(500).json({ error: 'Failed to create account.' });
  }
})
app.post('/api/verifyEmail', async(req, res) => {
  const receivedData = req.body;
  twilioClient.verify.v2.services('VA8a978c1104cca22c1e7c00602d9b46a7')
                .verifications
                .create({channelConfiguration: {
                   template_id: 'd-eb19b667f9f2470fa1fc6690c2160bf9',
                   from: 'dosavaglio741@gmail.com',
                   from_name: 'NuCliq'
                 }, to: receivedData.email, channel: 'email'})
                .then(verification => res.json(verification))

})
app.post('/api/testLang', async (req, res) => {
  const receivedData = req.body
  console.log(langdetect.detect(receivedData.data.value));
})
app.post('/api/uploadCliqPost', async(req, res) => {
  const data = req.body
  const { mood, caption, newPostArray, forSale, value, finalMentions, groupId, user: userId, pfp, notificationToken, username, blockedUsers, 
    background } = data.data;
  try {
    const batch = db.batch();
    if (newPostArray.length == 1 && newPostArray[0].video) {
      const docRef = db.collection('groups').doc(groupId).collection('videos').doc()
      const profileRef = db.collection('groups').doc(groupId).collection('users').doc(userId).collection('posts').doc(docRef.id)
      batch.set(docRef, {
        userId: userId,
        caption: caption,
        blockedUsers: blockedUsers,
        reportedIds: [],
        post: newPostArray.sort((a, b) => a.id - b.id),
        forSale: forSale,
        postIndex: 0,
        private: value,
        mentions: finalMentions,
        pfp: pfp,
        likedBy: [],
        comments: 0,
        shares: 0,
        usersSeen: [],
        commentsHidden: false,
        likesHidden: false,
        archived: false,
        savedBy: [],
        multiPost: true,
        timestamp: FieldValue.serverTimestamp(),
        notificationToken: notificationToken,
        username: username,
        reportVisible: false,
        background: background
      })
      batch.set(profileRef, {
        userId: userId,
        caption: caption,
        post: newPostArray.sort((a, b) => a.id - b.id),
        forSale: forSale,
        postIndex: 0,
        video: true,
        privacy: value,
        likedBy: [],
        repost: false,
        mentions: finalMentions,
        comments: 0,
        shares: 0,
        usersSeen: [],
        commentsHidden: false,
        likesHidden: false,
        archived: false,
        savedBy: [],
        multiPost: true,
        timestamp: FieldValue.serverTimestamp(),
        notificationToken: notificationToken,
        username: username,
        pfp: pfp,
        reportVisible: false,
      })
      await batch.commit();
      res.status(200).json({ done: true, docRefId: docRef.id});
    }
    else {
      const docRef = db.collection('groups').doc(groupId).collection('posts').doc()
      const profileRef = db.collection('groups').doc(groupId).collection('users').doc(userId).collection('posts').doc(docRef.id)
      batch.set(docRef, {
        userId: userId,
        caption: caption,
        blockedUsers: blockedUsers,
        post: newPostArray.sort((a, b) => a.id - b.id),
        forSale: forSale,
        postIndex: 0,
        reportedIds: [],
        mood: mood,
        private: value,
        mentions: finalMentions,
        pfp: pfp,
        likedBy: [],
        comments: 0,
        shares: 0,
        usersSeen: [],
        commentsHidden: false,
        likesHidden: false,
        archived: false,
        savedBy: [],
        multiPost: true,
        timestamp: FieldValue.serverTimestamp(),
        notificationToken: notificationToken,
        username: username,
        reportVisible: false,
        background: background
      })
      batch.set(profileRef, {
        userId: userId,
        caption: caption,
        post: newPostArray.sort((a, b) => a.id - b.id),
        forSale: forSale,
        postIndex: 0,
        video: false,
        privacy: value,
        likedBy: [],
        mentions: finalMentions,
        comments: 0,
        shares: 0,
        usersSeen: [],
        commentsHidden: false,
        likesHidden: false,
        archived: false,
        savedBy: [],
        multiPost: true,
        timestamp: FieldValue.serverTimestamp(),
        notificationToken: notificationToken,
        username: username,
        pfp: pfp,
        reportVisible: false,
        repost: false
      })
      await batch.commit();
      res.status(200).json({ done: true, docRefId: docRef.id});
    }
  }
  catch (error) {
    console.error(error);
    res.status(500).send('Error searching Spotify');
  }
})
app.post('/api/uploadPost', async(req, res) => {
  const data = req.body
  const { mood, caption, newPostArray, forSale, value, finalMentions, user: userId, pfp, notificationToken, username, blockedUsers, 
    background } = data.data;
  try {
    const batch = db.batch();
  if (newPostArray.length == 1 && newPostArray[0].video) {
    const docRef = db.collection('videos').doc()
    const profileRef = db.collection('profiles').doc(userId).collection('posts').doc(docRef.id)
    batch.set(docRef, {
      userId: userId,
      caption: caption,
      blockedUsers: blockedUsers,
      reportedIds: [],
      post: newPostArray.sort((a, b) => a.id - b.id),
      forSale: forSale,
      postIndex: 0,
      private: value,
      mentions: finalMentions,
      pfp: pfp,
      likedBy: [],
      comments: 0,
      shares: 0,
      usersSeen: [],
      commentsHidden: false,
      likesHidden: false,
      archived: false,
      savedBy: [],
      multiPost: true,
      timestamp: FieldValue.serverTimestamp(),
      notificationToken: notificationToken,
      username: username,
      reportVisible: false,
      background: background
    })
    batch.set(profileRef, {
      userId: userId,
      caption: caption,
      post: newPostArray.sort((a, b) => a.id - b.id),
      forSale: forSale,
      postIndex: 0,
      video: true,
      privacy: value,
      likedBy: [],
      repost: false,
      mentions: finalMentions,
      comments: 0,
      shares: 0,
      usersSeen: [],
      commentsHidden: false,
      likesHidden: false,
      archived: false,
      savedBy: [],
      multiPost: true,
      timestamp: FieldValue.serverTimestamp(),
      notificationToken: notificationToken,
      username: username,
      pfp: pfp,
      reportVisible: false,
    })
    await batch.commit();
    res.status(200).json({ done: true, docRefId: docRef.id});
  }
  else {
    const docRef = db.collection('posts').doc()
    const profileRef = db.collection('profiles').doc(userId).collection('posts').doc(docRef.id)
    batch.set(docRef, {
      userId: userId,
      caption: caption,
      blockedUsers: blockedUsers,
      post: newPostArray.sort((a, b) => a.id - b.id),
      forSale: forSale,
      postIndex: 0,
      reportedIds: [],
      mood: mood,
      private: value,
      mentions: finalMentions,
      pfp: pfp,
      likedBy: [],
      comments: 0,
      shares: 0,
      usersSeen: [],
      commentsHidden: false,
      likesHidden: false,
      archived: false,
      savedBy: [],
      multiPost: true,
      timestamp: FieldValue.serverTimestamp(),
      notificationToken: notificationToken,
      username: username,
      reportVisible: false,
      background: background
    })
    batch.set(profileRef, {
      userId: userId,
      caption: caption,
      post: newPostArray.sort((a, b) => a.id - b.id),
      forSale: forSale,
      postIndex: 0,
      video: false,
      privacy: value,
      likedBy: [],
      mentions: finalMentions,
      comments: 0,
      shares: 0,
      usersSeen: [],
      commentsHidden: false,
      likesHidden: false,
      archived: false,
      savedBy: [],
      multiPost: true,
      timestamp: FieldValue.serverTimestamp(),
      notificationToken: notificationToken,
      username: username,
      pfp: pfp,
      reportVisible: false,
      repost: false
    })
    await batch.commit();
    res.status(200).json({ done: true, docRefId: docRef.id});
  }
  }
  catch (error) {
    console.error(error);
    res.status(500).send('Error searching Spotify');
  }
})
app.get('/search', async (req, res) => {
  const query = req.query.q; // Get search query from request
  const accessToken = await getAccessToken();

  try {
    const response = await fetch(
      `https://api.spotify.com/v1/search?q=${query}&type=track`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );
    const data = await response.json();
    res.json(data); // Send search results back to the app
  } catch (error) {
    console.error(error);
    res.status(500).send('Error searching Spotify');
  }
});

app.post('/api/receipt', async(req, res) => {
  const receipt = req.body;
    try {
      console.log(receipt.receipt_data)
      // Primary validation (Production)
      const response = await fetch('https://buy.itunes.apple.com/verifyReceipt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          'receipt-data': receipt.receipt_data,
        }),
      });
  
      const data = await response.json();
      if (data.status === 0) {
        // Valid production receipt
        return data; 
      } else if (data.status === 21007) {
        // Sandbox receipt used in production
        const sandboxResponse = await fetch('https://sandbox.itunes.apple.com/verifyReceipt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            'receipt-data': receipt.receipt_data,
          }),
        });
  
        const sandboxData = await sandboxResponse.json();
        if (sandboxData.status === 0) {
          // Valid sandbox receipt
          return sandboxData; 
        } else {
          throw new Error('Invalid sandbox receipt');
        }
      } else {
        throw new Error(`Receipt validation failed with status: ${data.status}`);
      }
    } catch (error) {
      throw error; 
    }  
})
app.post('/api/endpoint', async (req, res) => {
  // Use an existing Customer ID if this is a returning customer.
  const account = await stripe.accounts.create({
    type: 'express',
  });
    const accountLink = await stripe.accountLinks.create({
    account: account.id,
    refresh_url: 'http://10.0.0.225:3000/AddCard',
    return_url: 'http://10.0.0.225:3000/AddCard',
    type: 'account_onboarding',
    });
    res.send({accountLink: accountLink, accountId: account.id})
   //console.log(accountLink)
});
const removeUnnecessaryNudityKeys = (data) => {
  const keysToRemove = ['none', 'context'];

  const removeKeysRecursively = (obj) => {
    if (typeof obj !== 'object' || obj === null) {
      return obj; // Base case: Not an object, return as is
    }

    // Iterate over object keys
    for (const key in obj) {
      if (keysToRemove.includes(key)) {
        delete obj[key]; // Remove unwanted keys
      } else if (typeof obj[key] === 'object') {
        removeKeysRecursively(obj[key]); // Recurse into nested objects
      }
    }

    return obj;
  };

  return removeKeysRecursively(data);
};
app.post('/api/imageModeration', async(req, res) => {
  console.log('Got Here')
  const receivedData = req.body;
  const url = receivedData.url
  const caption = receivedData.caption
  const actualPostArray = receivedData.actualPostArray
  const item = receivedData.item
  try {
    // Fetch Image Moderation Data
    console.log(IMAGE_MODERATION_URL)
    const response = await axios.get(IMAGE_MODERATION_URL, {
      params: {
        url,
        models: 'nudity-2.0,wad,offensive,scam,gore,qr-content',
        api_user: MODERATION_API_USER,
        api_secret: MODERATION_API_SECRET,
      },
    });

    const moderationData = response.data;
    const cleanedData = removeUnnecessaryNudityKeys(moderationData.nudity);
    const containsNumberGreaterThan = (array, threshold) => array.some((element) => element > threshold);
  
    const getValuesFromImages = (list) => {
        let values = [];
        list.forEach((item) => {
        if (typeof item === "number") values.push(item);
        if (typeof item === "object") {
            Object.values(item).forEach((value) => {
            if (typeof value === "number") values.push(value);
            if (typeof value === "object") values = values.concat(getValuesFromImages([value]));
            });
        }
        });

        return values;
    };
    //console.log(getValuesFromImages(Object.values(moderationData.nudity)))
    const moderationFailures = [
      moderationData.drugs > 0.9,
      moderationData.gore?.prob > 0.9,
      containsNumberGreaterThan(getValuesFromImages(Object.values(cleanedData)), 0.95),
      containsNumberGreaterThan(Object.values(moderationData.offensive), 0.9),
      moderationData.scam > 0.9,
      moderationData.weapon > 0.9,
    ];

    // Handle Caption Text Moderation
    if (caption.length > 0) {
      const formData = new FormData();
      formData.append('text', caption);
      formData.append('lang', 'en');
      formData.append('mode', 'rules');
      formData.append('api_user', MODERATION_API_USER);
      formData.append('api_secret', MODERATION_API_SECRET);

      const textResponse = await axios.post(TEXT_MODERATION_URL, formData);
      const { link, profanity } = textResponse.data;
      if (link.matches.length > 0) {
        res.json({
          setNewPostArray: setNewPostArray,
          linkError: true,
          profError: false
        })
      }

      if (profanity.matches.some(obj => obj.intensity === 'high')) {
        res.json({
          setNewPostArray: setNewPostArray,
          linkError: false,
          profError: true
        })
      }
    }

    // Update Post Array
    const updatedArray = actualPostArray.map(obj => ({ ...obj }));
    const newPostArray = []
    const targetIndex = actualPostArray.findIndex(e => e.post === item.post);
    updatedArray[targetIndex].post = url;
    newPostArray.push(updatedArray[targetIndex])
    res.json({
      newPostArray: newPostArray,
      linkError: false,
      profError: false
    })
  } catch (error) {
    console.error('Error in content moderation:', error);
  }
})
app.post('/api/videoModeration', async(req, res) => {
    const receivedData = req.body;
    sightengine.check(['nudity-2.0,wad,offensive,scam,gore,qr-content']).video_sync(receivedData.video).then(function(result) {
      // The API response (result)
      res.json(result)
    }).catch(function(err) {
      // Handle erro
      res.send(err)
    });
})

app.post('/api/purchaseEndpoint', async(req, res) => {
    const receivedData = req.body;

    const customer = await stripe.customers.create();
    const ephemeralKey = await stripe.ephemeralKeys.create(
      {customer: customer.id},
      {apiVersion: '2022-11-15'}
    );
    if (receivedData.userId) {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: parseInt(receivedData.price),
        currency: 'usd',
        receipt_email: receivedData.email,
        //payment_method_types: ['card'], 
        customer: customer.id,
        application_fee_amount: Math.round((parseInt(receivedData.price) * 0.3) + 30),
        transfer_data: {
          destination: receivedData.id,
        },
       payment_method_types: ['card'],
       metadata: {
          product_code: 'txcd_10000000'
       }
      });
      res.json({
        paymentIntent: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        ephemeralKey: ephemeralKey.secret,
        customer: customer.id,
        finalPrice: parseInt(receivedData.price),
      });
    }
    else {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: parseInt(receivedData.price),
        currency: 'usd',
        receipt_email: receivedData.email,
        //payment_method_types: ['card'], 
        customer: customer.id,
        /* application_fee_amount: Math.round((parseInt(receivedData.price) * 0.3) + 30),
        transfer_data: {
          destination: receivedData.id,
        }, */
       payment_method_types: ['card'],
       metadata: {
          product_code: 'txcd_10000000'
       }
      });
      res.json({
        paymentIntent: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        ephemeralKey: ephemeralKey.secret,
        customer: customer.id,
        finalPrice: parseInt(receivedData.price),
      });
    }
    
  })
app.post('/api/savedCardEndpoint', async (req, res) => {
    const receivedData = req.body;
    let email = receivedData.email

    try {
      if (receivedData.cvcToken && email) {

        const params = {
          amount: parseInt(receivedData.price),
          confirm: true,
          confirmation_method: 'manual',
          currency: 'usd',
          payment_method: receivedData.paymentMethodID,
          payment_method_options: {
            card: {
              cvc_token: receivedData.cvcToken,
            },
          },
          //use_stripe_sdk: useStripeSdk,
          customer: receivedData.customer,
          //return_url: 'stripe-example://stripe-redirect',
        };
        const intent = await stripe.paymentIntents.create(params);
          res.json({
            //paymentIntent: paymentIntent.client_secret,
            paymentIntentId: intent.id,
            //ephemeralKey: ephemeralKey.secret,
            customer: intent.customer,
          });
          console.log(`intent: ${intent}`)
      }
      //return res.sendStatus(400);
    } catch (e) {
      // Handle "hard declines" e.g. insufficient funds, expired card, etc
      return res.send({ error: e.message });
    }
  }
);
app.post('/api/productEndpoint', async(req, res) => {
    const receivedData = req.body;
    console.log(receivedData)
    const product = await stripe.products.create({
    name: receivedData.name,
    default_price_data: {
        unit_amount: receivedData.price,
        currency: 'usd',
        
    },
    images: receivedData.post,
    expand: ['default_price'],
    metadata: {
      nameInsensitive: receivedData.name.toUpperCase(),
      keywords: receivedData.keywords,
      timestamp: receivedData.timestamp,
      price: receivedData.price,
      bought_count: 0
    },
    
    })
    console.log(product)
})

app.post('/api/retrieveEndpoint', async(req, res) => {
    const receivedData = req.body;
    //console.log(receivedData)
      const paymentIntent = await stripe.paymentIntents.retrieve(
        receivedData.id
  );
    if (paymentIntent.payment_method_options.card.setup_future_usage != undefined) {
      const paymentMethod = await stripe.paymentMethods.retrieve(
        paymentIntent.payment_method
        
      )
      console.log(`Payment Method: ${paymentMethod}`)
      res.json({
        futureUsage: paymentIntent.payment_method_options.card.setup_future_usage, chargeId: paymentIntent.latest_charge, paymentMethodID: paymentIntent.payment_method, lastFour: paymentMethod.card.last4
      })
      /*  */
    }
    else {
      res.json({futureUsage: null, chargeId: paymentIntent.latest_charge})
    }
      
})

app.post('/api/refund', async(req, res) => {
  const receivedData = req.body;
  const refund = await stripe.refunds.create({
      charge: receivedData.chargeId,
      refund_application_fee: true,
      reverse_transfer: true
    }, {
      stripeAccount: receivedData.stripeAccount,
    });
})

app.post('/api/chargeEndpoint', async(req, res) => {
  const receivedData = req.body;
  //console.log(receivedData)
  const paymentIntent = await stripe.paymentIntents.capture(
    receivedData.pi
  );
  res.json({paymentIntent: paymentIntent})
})
app.post('/api/username', async(req, res) => {
    const receivedData = req.body
    data = new FormData();
    data.append('text', receivedData.username);
    data.append('lang', 'en');
    data.append('mode', 'username');
    data.append('api_user', MODERATION_API_USER);
    data.append('api_secret', MODERATION_API_SECRET);
    console.log(data)
    axios({
    url: 'https://api.sightengine.com/1.0/text/check.json',
    method:'post',
    data: data,
    headers: data.getHeaders()
    })
    .then(function (response) {
    // on success: handle response
    res.send(response.data)
    console.log(response.data);
    })
    .catch(function (error) {
    // handle error
    if (error.response) console.log(error.response.data);
    else console.log(error.message);
    });
    })
app.post('/api/text', (req, res) => {
    const receivedData = req.body
    console.log(receivedData)
    data = new FormData();
    data.append('text', receivedData.text);
    data.append('lang', 'en');
    data.append('mode', 'standard');
    data.append('api_user', MODERATION_API_USER);
    data.append('api_secret', MODERATION_API_SECRET);

    axios({
    url: 'https://api.sightengine.com/1.0/text/check.json',
    method:'post',
    data: data,
    headers: data.getHeaders()
    })
    .then(function (response) {
    // on success: handle response
    console.log(response.data);
    })
    .catch(function (error) {
    // handle error
    if (error.response) console.log(error.response.data);
    else console.log(error.message);
    });
    })
    
app.post('/api/textNotification', (req, res) => {
  const receivedData = req.body
  
  res.send(receivedData)
  let messages = [];
  messages.push({
    to: receivedData.pushToken,
    sound: 'default',
    title: `${receivedData.firstName} ${receivedData.lastName}`,
    body: `${receivedData.message.text}`
  })
  let chunks = expo.chunkPushNotifications(messages);
    let tickets = [];
    (async () => {
  for (let chunk of chunks) {
    try {
      let ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      console.log(ticketChunk);
      tickets.push(...ticketChunk);
   
    } catch (error) {
      console.error(error);
    }
  }
})();
messages = [];
chunks = [];
tickets = [];
})
app.post('/api/imageNotification', (req, res) => {
  const receivedData = req.body
  messages.push({
    to: receivedData.pushToken,
    sound: 'default',
    title: `${receivedData.firstName} ${receivedData.lastName}`,
    body: 'Sent a Photo'
  })
})
app.post('/api/postNotification', (req, res) => {
  const receivedData = req.body

  messages.push({
    to: receivedData.pushToken,
    sound: 'default',
    title: `${receivedData.firstName} ${receivedData.lastName}`,
    body: `Sent a Post by ${receivedData.username}`
  })
})
app.post('/api/likePost', async(req, res) => {
  console.log(req.body)
  const data = req.body
  const item = data.data.item
  const userId = data.data.user
  try {
    const batch = db.batch();
    const postRef = db.collection('posts').doc(item.id)
    const likesRef = db.collection('profiles').doc(userId).collection('likes').doc(item.id)
    const profileRef = db.collection('profiles').doc(item.userId).collection('notifications').doc()
    const profileCheckRef = db.collection('profiles').doc(item.userId).collection('checkNotifications').doc()
    batch.update(postRef, {
      likedBy: FieldValue.arrayUnion(userId)
    })
    batch.set(likesRef, {
      post: item.id,
      timestamp: FieldValue.serverTimestamp()
    })
    batch.set(profileRef, {
      like: true,
      comment: false,
      friend: false,
      item: item.id,
      request: false,
      acceptRequest: false,
      theme: false,
      report: false,
      postId: item.id,
      requestUser: userId,
      requestNotificationToken: item.notificationToken,
      likedBy: [],
      timestamp: FieldValue.serverTimestamp()
    })
    batch.set(profileCheckRef, {
      userId: item.userId
    })
    await batch.commit();
    res.status(200).json({ done: true });
  }
  catch (error) {
    console.error('Error adding like', error);
    res.status(500).json({ error: 'Failed to add like.' });
    }
})
app.post('/api/likeNotification', (req, res) => {
  const receivedData = req.body
  let messages = []
  messages.push({
    to: receivedData.pushToken,
    sound: 'default',
    body: `${receivedData.username} Liked Your Post`,
    data: receivedData.data
  })
  let chunks = expo.chunkPushNotifications(messages);
    let tickets = [];
    (async () => {
  for (let chunk of chunks) {
    try {
      let ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      console.log(ticketChunk);
      tickets.push(...ticketChunk);
    } catch (error) {
      console.error(error);
    }
  }
})();
messages = [];
chunks = [];
tickets = [];
})
app.post('/api/likeCommentNotification', (req, res) => {
  const receivedData = req.body
  messages.push({
    to: receivedData.pushToken,
    sound: 'default',
    title: `${receivedData.username} Liked Your Comment:`,
    body: `${receivedData.comment}`
  })
})
app.post('/api/likePostNotification', (req, res) => {
  const receivedData = req.body
  messages.push({
    to: receivedData.pushToken,
    sound: 'default',
    title: `${receivedData.firstName} ${receivedData.lastName}`,
    body: `Liked a Message You Shared`
  })
})
app.post('/api/replyNotification', (req, res) => {
  const receivedData = req.body
  messages.push({
    to: receivedData.pushToken,
    sound: 'default',
    title: `${receivedData.username} Replied to Your Comment:`,
    body: `${receivedData.comment}`
  })
})
app.post('/api/friendNotification', (req, res) => {
  const receivedData = req.body
  messages.push({
    to: receivedData.pushToken,
    sound: 'default',
    title: `New Friend`,
    body: `${receivedData.username} Added You as a Friend`
  })
})
app.listen(4000, () => {
  console.log('Server is running on port 4000');
});
